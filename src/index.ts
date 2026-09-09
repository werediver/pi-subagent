import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { loadExtensionConfig, type ExtensionConfig } from "./config.ts";
import { getModelClassAvailability, formatAvailableModelClasses, resolveModelClass, type ModelSettings } from "./model-resolver.ts";
import { ContinuationQueue } from "./queue.ts";
import { ChildRegistry, type ChildSession, disposeChild } from "./registry.ts";
import { runChildRequest } from "./runner.ts";
import { formatPreloadedSkills, resolvePreloadedSkills } from "./skills.ts";
import { createDelegateToolResult, resultError, type DelegateCmdResult } from "./result.ts";
import { oneLine } from "./text.ts";

const extensionSourcePath = fileURLToPath(import.meta.url);

const DelegateCmdParams = Type.Object({
	title: Type.String({ minLength: 1, description: "Short task description; prefer imperative form" }),
	input: Type.String({ minLength: 1, description: "The task to delegate or a response in a dialog" }),
	skills: Type.Optional(Type.Array(Type.String({}), { description: "Skills to pre-load into a new child session" })),
	modelClass: Type.Optional(Type.String({ description: "Model class for a new child session; defaults to `parent`" })),
	continue_session: Type.Optional(Type.String({ description: "The ID of an existing child session to continue; omit or leave empty to start a new child session" })),
});
export type DelegateCmdParams = Static<typeof DelegateCmdParams>;

function createExtensionFactory(mainModel: ModelSettings | undefined, registry: ChildRegistry, sourcePath: string): (pi: ExtensionAPI) => void {
	return (pi) => registerExtension(pi, mainModel, registry, sourcePath);
}

function registerExtension(pi: ExtensionAPI, mainModel: ModelSettings | undefined, registry = new ChildRegistry(), sourcePath = extensionSourcePath): void {
	const notifiedConfigurationWarnings = new Set<string>();
	let baseConfigCache: {
		cwd: string;
		trusted: boolean;
		result: { config: ExtensionConfig } | { error: unknown };
	} | undefined;
	const getBaseConfig = (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExtensionConfig => {
		const trusted = ctx.isProjectTrusted();
		if (baseConfigCache?.cwd === ctx.cwd && baseConfigCache.trusted === trusted) {
			if ("config" in baseConfigCache.result) return baseConfigCache.result.config;
			throw baseConfigCache.result.error;
		}
		try {
			const config = loadExtensionConfig(ctx);
			baseConfigCache = { cwd: ctx.cwd, trusted, result: { config } };
			return config;
		} catch (error) {
			baseConfigCache = { cwd: ctx.cwd, trusted, result: { error } };
			throw error;
		}
	};
	pi.on("session_shutdown", async () => { await registry.close(); });
	pi.on("tool_result", (event) => {
		const details = event.toolName === "delegate" ? event.details as DelegateCmdResult | undefined : undefined;
		if (details?.status !== "completed") return { isError: true };
	});
	pi.on("before_agent_start", (event, ctx) => {
		let config;
		try {
			config = getBaseConfig(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not load pi-subagent configuration: ${message}`, "warning");
			config = { modelClasses: {} };
		}
		const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
		const { names, diagnostics } = getModelClassAvailability(config, ctx, rootModel);
		if (ctx.hasUI) {
			for (const diagnostic of diagnostics) {
				if (notifiedConfigurationWarnings.has(diagnostic)) continue;
				notifiedConfigurationWarnings.add(diagnostic);
				ctx.ui.notify(`Could not resolve a configured model class: ${diagnostic}`, "warning");
			}
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${formatAvailableModelClasses(names, config)}` };
	});
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate a task to a subagent in a new or existing child session",
		promptSnippet: "Delegate a task to a subagent in a new or existing child session",
		promptGuidelines: [
			"Specify `title` and `input` always",
			"Optionally, specify `modelClass` and `skills` when starting a new child session",
			"When a task can benefit from the pre-populated context in an existing child session, use `continue_session` with the child session ID returned by a previous delegation request; omit it or leave it empty when starting a new child session.",
		],
		parameters: DelegateCmdParams,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const title = args.title?.trim() ? ` "${oneLine(args.title.trim())}"` : "";
			const continuationId = args.continue_session?.trim();
			const summary = continuationId
				? `continue ${oneLine(continuationId)}${title}`
				: `${oneLine(args.modelClass?.trim() || "parent")}${args.skills?.length ? ` + ${args.skills.map(oneLine).join(", ")}` : ""}${title}`;
			text.setText(`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", summary)}`);
			return text;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.title.trim()) return createDelegateToolResult(resultError("failed", "`title` must be a non-empty string."));
			if (!params.input.trim()) return createDelegateToolResult(resultError("failed", "`input` must be a non-empty string."));
			const abortSignal = signal ?? new AbortController().signal;
			const continuationId = params.continue_session?.trim();
			if (continuationId) {
				if (params.modelClass !== undefined || params.skills !== undefined) return createDelegateToolResult(resultError("failed", "Do not specify `modelClass` or `skills` when continuing an existing child session."));
				const child = registry.get(continuationId);
				if (!child || child.cwd !== ctx.cwd) return createDelegateToolResult(resultError("failed", "Session ID is unknown, expired, or cwd-mismatched. Use a valid child session ID returned by a previous delegation request, or omit `continue_session` (or leave it empty) to start a new child session."));
				const result = await child.queue.enqueue({ input: params.input, signal: abortSignal, onUpdate, theme: ctx.ui.theme });
				if (result.status === "completed") result.sessionId = continuationId;
				return createDelegateToolResult(result);
			}

			const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
			let resolvedModel: ModelSettings;
			try {
				resolvedModel = resolveModelClass(params.modelClass, getBaseConfig(ctx), ctx, rootModel);
			} catch (error) {
				return createDelegateToolResult(resultError("failed", error instanceof Error ? error.message : String(error)));
			}
			const nestedRegistry = new ChildRegistry();
			let child: ChildSession | undefined;
			let createdSession: AgentSession | undefined;
			try {
				const setup = (async () => {
					let preloadedSkills: Skill[] = [];
					const resourceLoader = new DefaultResourceLoader({
						cwd: ctx.cwd,
						agentDir: getAgentDir(),
						extensionsOverride: (current) => ({ ...current, extensions: current.extensions.filter((extension) => extension.path !== sourcePath && extension.resolvedPath !== sourcePath) }),
						extensionFactories: [{ name: "pi-subagent", factory: createExtensionFactory(rootModel, nestedRegistry, sourcePath), hidden: true }],
						noPromptTemplates: true,
						noThemes: true,
						skillsOverride: (current) => { preloadedSkills = resolvePreloadedSkills(current.skills, params.skills); return current; },
						appendSystemPromptOverride: (current) => preloadedSkills.length ? [...current, formatPreloadedSkills(preloadedSkills)] : current,
					});
					await resourceLoader.reload();
					if (registry.isClosed()) throw new Error("The extension runtime is shutting down.");
					const { session } = await createAgentSession({ cwd: ctx.cwd, model: resolvedModel.model, thinkingLevel: resolvedModel.thinkingLevel, resourceLoader, sessionManager: SessionManager.inMemory(ctx.cwd) });
					createdSession = session;
					if (registry.isClosed()) { session.dispose(); createdSession = undefined; throw new Error("The extension runtime is shutting down."); }
					child = { session, cwd: ctx.cwd, nestedRegistry, queue: undefined as never };
					child.queue = new ContinuationQueue(session, (request) => runChildRequest(child!, request.input, request.signal, request.onUpdate, request.theme, ctx.cwd));
					registry.add(child);
				})();
				await registry.trackSetup(setup);
				if (!child) throw new Error("Child session setup did not produce a session.");
				const result = await child.queue.startInitial({ input: params.input, signal: abortSignal, onUpdate, theme: ctx.ui.theme });
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

export default function (pi: ExtensionAPI): void {
	registerExtension(pi, undefined, undefined, extensionSourcePath);
}
