import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { loadExtensionConfig } from "./config.ts";
import { getAvailableModelClassNames, formatAvailableModelClasses, resolveModelClass, type ModelSettings } from "./model-resolver.ts";
import { ContinuationQueue } from "./queue.ts";
import { ChildRegistry, type ChildSession, disposeChild } from "./registry.ts";
import { runChildRequest } from "./runner.ts";
import { formatPreloadedSkills, resolvePreloadedSkills } from "./skills.ts";
import { createDelegateToolResult, resultError, type DelegateCmdResult } from "./result.ts";
import { oneLine } from "./text.ts";

const extensionSourcePath = fileURLToPath(import.meta.url);

const DelegateCmdParams = Type.Object({
	title: Type.String({ minLength: 1, description: "Short title describing the task; prefer an imperative verb phrase" }),
	task: Type.String({ minLength: 1, description: "The task to delegate" }),
	skills: Type.Optional(Type.Array(Type.String({}), { description: "Names of skills for an opening delegation" })),
	modelClass: Type.Optional(Type.String({ description: "Model class for an opening delegation; defaults to parent" })),
	continue_session: Type.Optional(Type.String({ description: "Previously returned child session ID to continue" })),
});
export type DelegateCmdParams = Static<typeof DelegateCmdParams>;

function createExtensionFactory(mainModel: ModelSettings | undefined, registry: ChildRegistry, sourcePath: string): (pi: ExtensionAPI) => void {
	return (pi) => registerExtension(pi, mainModel, registry, sourcePath);
}

function registerExtension(pi: ExtensionAPI, mainModel: ModelSettings | undefined, registry = new ChildRegistry(), sourcePath = extensionSourcePath): void {
	pi.on("session_shutdown", async () => { await registry.close(); });
	pi.on("tool_result", (event) => {
		const details = event.toolName === "delegate" ? event.details as DelegateCmdResult | undefined : undefined;
		if (details?.status !== "completed") return { isError: true };
	});
	pi.on("before_agent_start", (event, ctx) => {
		let config;
		try {
			config = loadExtensionConfig(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not load pi-subagent configuration: ${message}`, "warning");
			config = { modelClasses: {} };
		}
		const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
		const names = getAvailableModelClassNames(config, ctx, rootModel);
		return { systemPrompt: `${event.systemPrompt}\n\n${formatAvailableModelClasses(names, config)}` };
	});
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate a task to an independent child agent. Open a child session or continue a previously returned child session.",
		promptSnippet: "Delegate work to an independent child agent; reuse a returned session ID for follow-up work.",
		promptGuidelines: [
			"Opening calls may provide modelClass and skills. A successful opening call returns a session ID.",
			"Continuation calls must provide only continue_session, title, and task; they reuse the child session's existing model and skills.",
			"Use the returned session ID in continue_session to add a task to the same child context. Continuations for one child are serialized; a failed or cancelled continuation stops later queued continuations.",
		],
		parameters: DelegateCmdParams,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const title = args.title?.trim() ? ` "${oneLine(args.title.trim())}"` : "";
			const summary = args.continue_session !== undefined
				? `continue ${oneLine(args.continue_session.trim() || "(missing session ID)")}${title}`
				: `${oneLine(args.modelClass?.trim() || "parent")}${args.skills?.length ? ` + ${args.skills.map(oneLine).join(", ")}` : ""}${title}`;
			text.setText(`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", summary)}`);
			return text;
		},
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
			try {
				resolvedModel = resolveModelClass(params.modelClass, loadExtensionConfig(ctx), ctx, rootModel);
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

export default function (pi: ExtensionAPI): void {
	registerExtension(pi, undefined, undefined, extensionSourcePath);
}
