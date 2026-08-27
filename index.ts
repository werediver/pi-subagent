import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	CONFIG_DIR_NAME,
	parseFrontmatter,
	SessionManager,
	type AgentSession,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { SubagentToolCallRenderer } from "./subagent-tool-renderer.ts";

type ModelClassDefinition =
	| { model: string; provider?: string; thinkingLevel?: ModelThinkingLevel; description?: string }
	| { base: string; thinkingLevel?: ModelThinkingLevel; description?: string }
	| { description: string };

type ExtensionConfig = { modelClasses: Record<string, ModelClassDefinition> };
type ModelSettings = { model: Model<any>; thinkingLevel?: ModelThinkingLevel };
const extensionSourcePath = fileURLToPath(import.meta.url);

const DelegateCmdParams = Type.Object({
	title: Type.String({ minLength: 1, description: "Short title describing the task; prefer an imperative verb phrase" }),
	task: Type.String({ minLength: 1, description: "The task to delegate" }),
	skills: Type.Optional(Type.Array(Type.String({}), {
		description: "Names of skills for an opening delegation",
	})),
	modelClass: Type.Optional(Type.String({ description: "Model class for an opening delegation; defaults to parent" })),
	continue_session: Type.Optional(Type.String({ description: "Previously returned child session ID to continue" })),
});
export type DelegateCmdParams = Static<typeof DelegateCmdParams>;

function readJsonFile(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf-8")); }
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Could not read extension configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseExtensionConfig(value: unknown, path: string): ExtensionConfig {
	const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
	const isThinkingLevel = (item: unknown): item is ModelThinkingLevel => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item as string);
	if (value === undefined) return { modelClasses: {} };
	if (!isRecord(value)) throw new Error(`Extension configuration at ${path} must be a JSON object.`);
	if (value.modelClasses === undefined) return { modelClasses: {} };
	if (!isRecord(value.modelClasses)) throw new Error(`The modelClasses property in ${path} must be a JSON object.`);
	const modelClasses: Record<string, ModelClassDefinition> = {};
	for (const [name, raw] of Object.entries(value.modelClasses)) {
		if (!isRecord(raw)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} must be an object.`);
		const allowedKeys = new Set(["model", "provider", "base", "thinkingLevel", "description"]);
		for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an unknown property ${JSON.stringify(key)}.`);
		const stringValue = (key: string): string | undefined => {
			if (!(key in raw)) return undefined;
			if (typeof raw[key] !== "string") throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid ${key}.`);
			const value = (raw[key] as string).trim();
			if (!value) throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid ${key}.`);
			return value;
		};
		const base = stringValue("base");
		const model = stringValue("model");
		const provider = stringValue("provider");
		const description = stringValue("description");
		const thinkingLevel = raw.thinkingLevel === undefined ? undefined : raw.thinkingLevel;
		if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid thinkingLevel.`);
		if (name === "parent" || name === "main") {
			if (model || base || provider || thinkingLevel || !description) throw new Error(`Built-in model class ${JSON.stringify(name)} in ${path} may only specify a description.`);
			modelClasses[name] = { description };
			continue;
		}
		if ((model !== undefined) === (base !== undefined)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} must define exactly one of model or base.`);
		if (base !== undefined && provider !== undefined) throw new Error(`Model class ${JSON.stringify(name)} in ${path} cannot specify a provider when using a base class.`);
		modelClasses[name] = base !== undefined
			? { base, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }) }
			: { model: model!, ...(provider === undefined ? {} : { provider }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }) };
	}
	return { modelClasses };
}

function loadExtensionConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExtensionConfig {
	const globalPath = join(getAgentDir(), "subagent.json");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "subagent.json");
	const globalConfig = parseExtensionConfig(readJsonFile(globalPath), globalPath);
	const projectConfig = parseExtensionConfig(ctx.isProjectTrusted() ? readJsonFile(projectPath) : undefined, projectPath);
	return { modelClasses: { ...globalConfig.modelClasses, ...projectConfig.modelClasses } };
}

function resolveModelClass(requestedClass: string | undefined, config: ExtensionConfig, ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">, mainModel: ModelSettings | undefined): ModelSettings {
	const name = requestedClass?.trim() || "parent";
	const resolving = new Set<string>();
	const resolve = (className: string): ModelSettings => {
		if (resolving.has(className)) throw new Error(`Circular model class reference involving ${JSON.stringify(className)}.`);
		resolving.add(className);
		try {
			if (className === "parent") {
				if (!ctx.model) throw new Error("The parent session has no active model.");
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			}
			if (className === "main") {
				if (!mainModel) throw new Error("The main session has no active model.");
				return mainModel;
			}
			const definition = config.modelClasses[className];
			if (!definition) throw new Error(`Unknown model class ${JSON.stringify(className)}. Configure it in subagent.json.`);
			if ("base" in definition) {
				const base = resolve(definition.base);
				const inheritedThinkingLevel = definition.base === "parent" || definition.base === "main" ? undefined : base.thinkingLevel;
				return { model: base.model, thinkingLevel: definition.thinkingLevel ?? inheritedThinkingLevel };
			}
			if (!("model" in definition)) throw new Error(`Model class ${JSON.stringify(className)} must define a model or a base class.`);
			const provider = definition.provider ?? mainModel?.model.provider ?? ctx.model?.provider;
			if (!provider) throw new Error(`Model class ${JSON.stringify(className)} needs a provider because the root session has no active model.`);
			const model = ctx.modelRegistry.getAll().find((candidate) => candidate.id === definition.model && candidate.provider === provider);
			if (!model) throw new Error(`Model ${provider}/${definition.model} for model class ${JSON.stringify(className)} was not found.`);
			return { model, thinkingLevel: definition.thinkingLevel };
		} finally { resolving.delete(className); }
	};
	return resolve(name);
}

type DelegateCmdResult = { status: "completed" | "failed" | "cancelled"; sessionId?: string; text?: string; error?: string };
type DelegateCmdProgress = { status: "running"; text?: string; currentTool?: string; currentToolArgs?: unknown; currentToolDisplay?: string; toolText?: string; turns: number };
type ActiveTool = { toolName: string; args: unknown; display?: string; toolText?: string };

type ChildSession = { session: AgentSession; cwd: string; queue: ContinuationQueue; nestedRegistry: ChildRegistry; cleanup?: Promise<void> };
type QueuedRequest = { task: string; signal: AbortSignal; onUpdate?: AgentToolUpdateCallback; theme?: Theme; batch: number };
function resultError(status: "failed" | "cancelled", error: string): DelegateCmdResult { return { status, error }; }

class ContinuationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private nextBatch = 0;
	private broken: { result: DelegateCmdResult; batch: number } | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	constructor(private readonly session: AgentSession, private readonly run: (request: QueuedRequest) => Promise<DelegateCmdResult>) { }
	private schedule(request: QueuedRequest, initial: boolean): Promise<DelegateCmdResult> {
		const previous = this.tail;
		const batch = request.batch;
		this.pending++;
		const operation = (async () => {
			if (!initial) await previous;
			if (this.closed || request.signal.aborted) return resultError("cancelled", this.closed ? "Child session was closed." : "Continuation was cancelled while waiting.");
			if (!initial && this.broken?.batch === batch) {
				return resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled.");
			}
			return this.run(request);
		})();
		const result = operation
			.catch((error) => resultError(request.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)))
			.then((value) => {
				if (value.status !== "completed" && this.broken?.batch !== batch) {
					this.broken = { result: value, batch };
					this.nextBatch++;
				}
				return value;
			})
			.finally(() => { this.pending--; if (!this.pending) this.broken = undefined; });
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
	startInitial(request: Omit<QueuedRequest, "batch">): Promise<DelegateCmdResult> { return this.schedule({ ...request, batch: this.nextBatch }, true); }
	enqueue(request: Omit<QueuedRequest, "batch">): Promise<DelegateCmdResult> { return this.schedule({ ...request, batch: this.nextBatch }, false); }
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => { await this.session.abort().catch(() => { }); await this.tail; })();
		return this.closing;
	}
}

class ChildRegistry {
	private readonly children = new Map<string, ChildSession>();
	private readonly setups = new Set<Promise<unknown>>();
	private closed = false;
	private closing: Promise<void> | undefined;
	isClosed(): boolean { return this.closed; }
	get(id: string): ChildSession | undefined { return this.children.get(id); }
	add(child: ChildSession): void { if (this.closed) throw new Error("The extension runtime is shutting down."); this.children.set(child.session.sessionId, child); }
	remove(id: string, child: ChildSession): void { if (this.children.get(id) === child) this.children.delete(id); }
	trackSetup<T>(setup: Promise<T>): Promise<T> { this.setups.add(setup); return setup.finally(() => this.setups.delete(setup)); }
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			await Promise.all([...this.children.values()].map((child) => disposeChild(child)));
			await Promise.allSettled([...this.setups]);
			this.children.clear();
		})();
		return this.closing;
	}
}

function sanitizeDisplayText(value: string): string {
	return stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
function sanitizeXmlText(value: string): string {
	let result = "";
	for (const character of sanitizeDisplayText(value)) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= 0x10ffff)) result += character;
	}
	return result;
}
function oneLine(value: string): string { return sanitizeDisplayText(value).replace(/[\r\n]+/g, " "); }
function escapeXml(value: string): string { return sanitizeXmlText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"); }
function formatDelegateResult(result: DelegateCmdResult): string {
	const lines = ["<delegate_result>", `  <status>${escapeXml(result.status)}</status>`];
	if (result.status === "completed") { if (result.sessionId) lines.push(`  <session_id>${escapeXml(result.sessionId)}</session_id>`); if (result.text !== undefined) lines.push(`  <text>${escapeXml(result.text)}</text>`); }
	else lines.push(`  <error>${escapeXml(result.error ?? "Delegation failed.")}</error>`);
	lines.push("</delegate_result>");
	return lines.join("\n");
}
function createDelegateToolResult(result: DelegateCmdResult) { return { content: [{ type: "text" as const, text: formatDelegateResult(result) }], details: result, ...(result.status !== "completed" ? { isError: true } : {}) }; }

async function disposeChild(child: ChildSession): Promise<void> {
	if (child.cleanup) return child.cleanup;
	child.cleanup = (async () => { await child.nestedRegistry.close(); await child.queue.close(); child.session.dispose(); })();
	return child.cleanup;
}

function formatToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const values = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["path", "file_path", "command", "query", "pattern", "directory", "cwd"]) if (typeof values[key] === "string" && values[key].trim()) parts.push(`${key}: ${oneLine(values[key])}`);
	if (typeof values.offset === "number" || typeof values.limit === "number") { const range = [values.offset, values.limit].filter((value) => typeof value === "number").join(", "); if (range) parts.push(`range: ${range}`); }
	return parts.length ? ` (${parts.join("; ")})` : "";
}
function formatProgress(progress: DelegateCmdProgress): string {
	const text = [progress.text, progress.currentTool ? `Subagent is using ${progress.currentToolDisplay || `${oneLine(progress.currentTool)}${formatToolArgs(progress.currentToolArgs)}`} (turn ${progress.turns})...` : undefined, progress.toolText ? `Tool output:\n${progress.toolText}` : undefined].filter((section): section is string => Boolean(section)).join("\n\n") || `Subagent is thinking (turn ${progress.turns})...`;
	return sanitizeDisplayText(text);
}
function getAssistantProgressText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return "";
	return sanitizeDisplayText(message.content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "thinking" && typeof part.thinking === "string" ? `Thinking:\n${part.thinking}` : "").filter(Boolean).join("\n\n"));
}
function getToolProgressText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	return sanitizeDisplayText(result.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n\n"));
}
function getAssistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return "";
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n\n");
}
function getDelegateOutcome(messages: readonly any[], aborted: boolean): DelegateCmdResult {
	const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
	if (aborted || assistant?.stopReason === "aborted") return resultError("cancelled", assistant?.errorMessage || "Delegation was cancelled.");
	if (assistant?.stopReason === "error") return resultError("failed", assistant.errorMessage || "Delegation failed.");
	const text = assistant ? getAssistantText(assistant) : "";
	return text ? { status: "completed", text } : { status: "completed" };
}
function resolvePreloadedSkills(availableSkills: readonly Skill[], requestedNames?: readonly string[]): Skill[] {
	if (!requestedNames?.length) return [];
	const skillsByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
	const names = [...new Set(requestedNames.map((name) => { const trimmed = name.trim(); if (!trimmed) throw new Error("Skill names must be non-empty."); return trimmed; }))];
	const missing = names.filter((name) => !skillsByName.has(name));
	if (missing.length) throw new Error(`Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.${availableSkills.length ? ` Available skills: ${availableSkills.map((skill) => skill.name).join(", ")}.` : ""}`);
	return names.map((name) => skillsByName.get(name)!);
}
function escapeXmlAttribute(value: string): string { return escapeXml(value); }
function formatPreloadedSkills(skills: readonly Skill[]): string {
	const blocks = skills.map((skill) => {
		const parsed = parseFrontmatter(readFileSync(skill.filePath, "utf-8"));
		return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${escapeXml(skill.baseDir)}.\n\n${sanitizeXmlText(parsed.body)}\n</skill>`;
	});
	return ["The following skills were explicitly pre-loaded for this task. Respect them when carrying out the task.", "<preloaded_skills>", blocks.join("\n\n"), "</preloaded_skills>"].join("\n");
}

function createExtensionFactory(mainModel: ModelSettings | undefined, registry: ChildRegistry): (pi: ExtensionAPI) => void { return (pi) => registerExtension(pi, mainModel, registry); }


async function runChildRequest(child: ChildSession, task: string, signal: AbortSignal, onUpdate: AgentToolUpdateCallback | undefined, theme: Theme | undefined, cwd: string): Promise<DelegateCmdResult> {
	let aborting = false, turns = 0, lastProgressText: string | undefined;
	const activeTools = new Map<string, ActiveTool>();
	let currentToolCallId: string | undefined;
	const renderer = theme ? new SubagentToolCallRenderer(child.session, theme, cwd) : undefined;
	const getCurrentTool = () => currentToolCallId ? activeTools.get(currentToolCallId) : undefined;
	const emitProgress = () => { const current = getCurrentTool(); onUpdate?.({ content: [{ type: "text", text: formatProgress({ status: "running", text: lastProgressText, currentTool: current?.toolName, currentToolArgs: current?.args, currentToolDisplay: current?.display, toolText: current?.toolText, turns }) }], details: { status: "running", text: lastProgressText, currentTool: current?.toolName, currentToolArgs: current?.args, currentToolDisplay: current?.display, toolText: current?.toolText, turns, activeTools: [...activeTools.entries()].map(([toolCallId, tool]) => ({ toolCallId, toolName: tool.toolName, args: tool.args, display: tool.display, toolText: tool.toolText })) } }); };
	const startIndex = child.session.messages.length;
	const unsubscribe = child.session.subscribe((event) => {
		switch (event.type) {
			case "turn_start": turns++; emitProgress(); break;
			case "message_start": if (event.message.role === "assistant") { lastProgressText = undefined; emitProgress(); } break;
			case "message_update": if (event.message.role === "assistant") { const partial = "partial" in event.assistantMessageEvent ? event.assistantMessageEvent.partial : event.message; const text = getAssistantProgressText(partial); if (text) lastProgressText = text; emitProgress(); } break;
			case "tool_execution_start": {
				const display = renderer?.renderCall(event.toolCallId, event.toolName, event.args);
				activeTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, display });
				currentToolCallId = event.toolCallId;
				activeTools.get(event.toolCallId)!.toolText = undefined;
				emitProgress();
				break;
			}
			case "tool_execution_update": {
				const active = activeTools.get(event.toolCallId);
				const toolName = active?.toolName ?? event.toolName;
				const args = active?.args ?? event.args;
				const rendered = renderer?.renderResult(event.toolCallId, toolName, args, event.partialResult, true, false);
				const fallback = getToolProgressText(event.partialResult);
				const text = rendered === undefined ? fallback : rendered;
				if (active) active.toolText = text;
				currentToolCallId = event.toolCallId;
				emitProgress();
				break;
			}
			case "tool_execution_end": {
				const active = activeTools.get(event.toolCallId);
				const rendered = renderer?.renderResult(event.toolCallId, active?.toolName ?? event.toolName, active?.args, event.result, false, event.isError);
				const fallback = getToolProgressText(event.result);
				const text = rendered === undefined ? fallback : rendered;
				if (active) active.toolText = text;
				emitProgress();
				renderer?.finish(event.toolCallId);
				activeTools.delete(event.toolCallId);
				if (currentToolCallId === event.toolCallId) currentToolCallId = [...activeTools.keys()].at(-1);
				break;
			}
		}
	});
	let abortCleanup: Promise<void> | undefined;
	const abort = () => { aborting = true; abortCleanup ??= child.session.abort().catch(() => { }); };
	if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	try { await child.session.prompt(task); return getDelegateOutcome(child.session.messages.slice(startIndex), aborting || signal.aborted); }
	catch (error) { return resultError(aborting || signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)); }
	finally { signal.removeEventListener("abort", abort); if (abortCleanup) await abortCleanup; renderer?.clear(); unsubscribe(); activeTools.clear(); }
}

function registerExtension(pi: ExtensionAPI, mainModel: ModelSettings | undefined, registry = new ChildRegistry()) {
	pi.on("session_shutdown", async () => { await registry.close(); });
	pi.on("tool_result", (event) => { const details = event.toolName === "delegate" ? event.details as DelegateCmdResult | undefined : undefined; if (details?.status !== "completed") return { isError: true }; });
	pi.on("before_agent_start", (event, ctx) => { try { const config = loadExtensionConfig(ctx); const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined); const names = getAvailableModelClassNames(config, ctx, rootModel); return { systemPrompt: `${event.systemPrompt}\n\n${formatAvailableModelClasses(names, config)}` }; } catch { return undefined; } });
	pi.registerTool({
		name: "delegate", label: "Delegate", description: "Delegate a task to an independent child agent. Open a child session or continue a previously returned child session.", promptSnippet: "Delegate work to an independent child agent; reuse a returned session ID for follow-up work.", promptGuidelines: ["Opening calls may provide modelClass and skills. A successful opening call returns a session ID.", "Continuation calls must provide only continue_session, title, and task; they reuse the child session's existing model and skills.", "Use the returned session ID in continue_session to add a task to the same child context. Continuations for one child are serialized; a failed or cancelled continuation stops later queued continuations."], parameters: DelegateCmdParams,
		renderCall(args, theme, context) { const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0); const title = args.title?.trim() ? ` "${oneLine(args.title.trim())}"` : ""; const summary = args.continue_session !== undefined ? `continue ${oneLine(args.continue_session.trim() || "(missing session ID)")}${title}` : `${oneLine(args.modelClass?.trim() || "parent")}${args.skills?.length ? ` + ${args.skills.map(oneLine).join(", ")}` : ""}${title}`; text.setText(`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", summary)}`); return text; },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.title.trim()) return createDelegateToolResult(resultError("failed", "title must be a non-empty string."));
			if (!params.task.trim()) return createDelegateToolResult(resultError("failed", "task must be a non-empty string."));
			const abortSignal = signal ?? new AbortController().signal;
			const hasContinuation = params.continue_session !== undefined;
			const continuationId = params.continue_session?.trim();
			if (hasContinuation) {
				if (!continuationId) return createDelegateToolResult(resultError("failed", "continue_session must be a non-empty child session ID."));
				if (params.modelClass !== undefined || params.skills !== undefined) return createDelegateToolResult(resultError("failed", "A continuation must not specify modelClass or skills."));
				const child = registry.get(continuationId);
				if (!child || child.cwd !== ctx.cwd) return createDelegateToolResult(resultError("failed", "Unknown, expired, or cwd-mismatched child session ID."));
				const result = await child.queue.enqueue({ task: params.task, signal: abortSignal, onUpdate, theme: ctx.ui.theme });
				if (result.status === "completed") result.sessionId = continuationId;
				return createDelegateToolResult(result);
			}
			const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
			let resolvedModel: ModelSettings;
			try { resolvedModel = resolveModelClass(params.modelClass, loadExtensionConfig(ctx), ctx, rootModel); }
			catch (error) { return createDelegateToolResult(resultError("failed", error instanceof Error ? error.message : String(error))); }
			const nestedRegistry = new ChildRegistry();
			let child: ChildSession | undefined;
			let createdSession: AgentSession | undefined;
			try {
				const setup = (async () => {
					let preloadedSkills: Skill[] = [];
					const resourceLoader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir(), extensionsOverride: (current) => ({ ...current, extensions: current.extensions.filter((extension) => extension.path !== extensionSourcePath && extension.resolvedPath !== extensionSourcePath) }), extensionFactories: [{ name: "pi-subagent", factory: createExtensionFactory(rootModel, nestedRegistry), hidden: true }], noPromptTemplates: true, noThemes: true, skillsOverride: (current) => { preloadedSkills = resolvePreloadedSkills(current.skills, params.skills); return current; }, appendSystemPromptOverride: (current) => preloadedSkills.length ? [...current, formatPreloadedSkills(preloadedSkills)] : current });
					await resourceLoader.reload();
					if (registry.isClosed()) throw new Error("The extension runtime is shutting down.");
					const { session } = await createAgentSession({ cwd: ctx.cwd, model: resolvedModel.model, thinkingLevel: resolvedModel.thinkingLevel, resourceLoader, sessionManager: SessionManager.inMemory(ctx.cwd) });
					createdSession = session;
					if (registry.isClosed()) { session.dispose(); createdSession = undefined; throw new Error("The extension runtime is shutting down."); }
					child = { session, cwd: ctx.cwd, nestedRegistry, queue: undefined as never };
					child.queue = new ContinuationQueue(session, (request) => runChildRequest(child!, request.task, request.signal, request.onUpdate, request.theme, ctx.cwd));
					registry.add(child);
				})();
				await registry.trackSetup(setup);
				if (!child) throw new Error("Child session setup did not produce a session.");
				const result = await child.queue.startInitial({ task: params.task, signal: abortSignal, onUpdate, theme: ctx.ui.theme });
				if (result.status !== "completed") { registry.remove(child.session.sessionId, child); await disposeChild(child); return createDelegateToolResult(result); }
				result.sessionId = child.session.sessionId;
				return createDelegateToolResult(result);
			} catch (error) {
				if (child) { registry.remove(child.session.sessionId, child); await disposeChild(child); }
				else { createdSession?.dispose(); await nestedRegistry.close(); }
				return createDelegateToolResult(resultError(abortSignal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)));
			}
		},
	});
}

function formatAvailableModelClasses(names: readonly string[], config: ExtensionConfig): string { const descriptions = new Map([["parent", "The parent session model (default)"], ["main", "The main session model"]]); return ["The following model classes are available for the `delegate` tool. Set `modelClass` to one of these names.", "<delegate_modelClass_options>", names.map((name) => { const description = config.modelClasses[name]?.description ?? descriptions.get(name); return description ? `- ${escapeXml(JSON.stringify(oneLine(name)))}: ${escapeXml(oneLine(description))}` : `- ${escapeXml(JSON.stringify(oneLine(name)))}`; }).join("\n"), "</delegate_modelClass_options>"].join("\n"); }
function getAvailableModelClassNames(config: ExtensionConfig, ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">, mainModel: ModelSettings | undefined): string[] { const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined); const names = [...(ctx.model ? ["parent"] : []), ...(rootModel ? ["main"] : [])]; for (const name of Object.keys(config.modelClasses).sort()) if (name !== "parent" && name !== "main") try { resolveModelClass(name, config, ctx, rootModel); names.push(name); } catch { } return names; }

export default function (pi: ExtensionAPI) { registerExtension(pi, undefined); }
