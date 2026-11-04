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
import { buildAgentSnapshot, captureAgentSources, type AgentSnapshot, type AgentSources } from "./agent-definitions.ts";
import { formatAgentDigest, getAgentAvailability, resolveAgentModel, type ModelSettings } from "./model-resolver.ts";
import { ContinuationQueue } from "./queue.ts";
import { ChildRegistry, type ChildSession, disposeChild } from "./registry.ts";
import { runChildRequest } from "./runner.ts";
import { evaluateToolAccess } from "./tool-access.ts";
import { formatPreloadedSkills, resolvePreloadedSkills } from "./skills.ts";
import { createDelegateToolResult, resultError, type DelegateCmdResult } from "./result.ts";
import { oneLine } from "./text.ts";

const extensionSourcePath = fileURLToPath(import.meta.url);

const DelegateCmdParams = Type.Object({
	title: Type.String({ minLength: 1, description: "Short task description; prefer imperative form" }),
	input: Type.String({ minLength: 1, description: "The task to delegate or a response in a dialog" }),
	agent: Type.Optional(Type.String({ description: "Agent definition for a new child session; required when opening" })),
	continue_session: Type.Optional(Type.String({ description: "The ID of an existing child session to continue; omit or leave empty to start a new child session" })),
});
export type DelegateCmdParams = Static<typeof DelegateCmdParams>;

// Pi contexts expose live model and thinking getters. Only the root runtime owns
// this reference; descendants read it rather than capturing a model at creation.
type RootSharedState = {
	context?: ExtensionContext;
	closed: boolean;
	baseConfig?: { config: ExtensionConfig } | { error: unknown };
	sources?: AgentSources;
	snapshot?: AgentSnapshot;
	skills?: readonly Skill[];
};

function createExtensionFactory(root: RootSharedState, registry: ChildRegistry, sourcePath: string, callerSubordinationLevel: number): (pi: ExtensionAPI) => void {
	return (pi) => registerExtension(pi, root, registry, sourcePath, callerSubordinationLevel + 1);
}

function registerExtension(pi: ExtensionAPI, root: RootSharedState, registry = new ChildRegistry(), sourcePath = extensionSourcePath, subordinationLevel = 0): void {
	const notifiedConfigurationWarnings = new Set<string>();
	// Pi emits these around one assistant response and its complete tool-call batch.
	let activeTurnBatch: symbol | undefined;
	pi.on("turn_start", () => { activeTurnBatch = Symbol("delegate-turn"); });
	pi.on("turn_end", () => { activeTurnBatch = undefined; });
	const getBaseConfig = (): ExtensionConfig => {
		if (root.snapshot) return root.snapshot.config;
		if (root.sources) return root.sources.config;
		if (!root.baseConfig) {
			if (!root.context || root.closed) throw new Error("The root session is unavailable.");
			try { root.baseConfig = { config: loadExtensionConfig(root.context) }; }
			catch (error) { root.baseConfig = { error }; }
		}
		if ("config" in root.baseConfig) return root.baseConfig.config;
		throw root.baseConfig.error;
	};
	const captureRootSources = (ctx: ExtensionContext): AgentSources => {
		if (!root.sources) root.sources = captureAgentSources({ cwd: ctx.cwd, agentDir: getAgentDir(), trusted: ctx.isProjectTrusted(), config: getBaseConfig() });
		return root.sources;
	};
	const reportConfigError = (ctx: ExtensionContext, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		if (notifiedConfigurationWarnings.has(message)) return;
		notifiedConfigurationWarnings.add(message);
		if (ctx.hasUI) ctx.ui.notify(`Could not load pi-subagent configuration: ${message}`, "warning");
		else console.warn(`Could not load pi-subagent configuration: ${message}`);
	};
	if (subordinationLevel === 0) {
		const updateRootContext = (_event: unknown, ctx: ExtensionContext) => { if (!root.closed) root.context = ctx; };
		pi.on("session_start", (event, ctx) => {
			updateRootContext(event, ctx);
			if (!root.closed) try { captureRootSources(ctx); } catch (error) { reportConfigError(ctx, error); }
		});
		pi.on("model_select", updateRootContext);
		pi.on("thinking_level_select", updateRootContext);
	}
	pi.on("session_shutdown", async () => {
		if (subordinationLevel === 0) { root.closed = true; root.context = undefined; }
		await registry.close();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "delegate") return;
		const details = event.details as DelegateCmdResult | undefined;
		if (details?.status !== "completed") return { isError: true };
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (subordinationLevel === 0 && !root.closed) {
			root.context = ctx;
			if (!root.snapshot) {
				try {
					// The full loaded skill list is exposed only after resource discovery.
					const skills = event.systemPromptOptions.skills ?? [];
					root.snapshot = buildAgentSnapshot(captureRootSources(ctx), skills.map((skill) => skill.name));
					root.skills = [...skills];
					for (const diagnostic of root.snapshot.diagnostics) {
						const message = `Agent definition ${diagnostic.filename}: ${diagnostic.reason}`;
						if (ctx.hasUI) ctx.ui.notify(message, "warning");
						else console.warn(message);
					}
				} catch (error) { reportConfigError(ctx, error); }
			}
		}
		if (!event.systemPromptOptions.selectedTools?.includes("delegate") || !root.snapshot || !root.context || root.closed) return;
		const rootContext = root.context;
		const rootModel = rootContext.model ? { model: rootContext.model, thinkingLevel: rootContext.thinkingLevel } : undefined;
		const available = getAgentAvailability(root.snapshot, ctx, rootModel, rootContext.modelRegistry);
		return { systemPrompt: `${event.systemPrompt}\n\n${formatAgentDigest(available)}` };
	});
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate a task to a subagent in a new or existing child session",
		promptSnippet: "Delegate a task to a subagent in a new or existing child session",
		promptGuidelines: [
			"Specify `title` and `input` always",
			"Specify `agent` when starting a new child session; omit it for continuations",
			"When a task can benefit from the pre-populated context in an existing child session, use `continue_session` with the child session ID returned by a previous delegation request; omit it or leave it empty when starting a new child session.",
		],
		parameters: DelegateCmdParams,
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const title = args.title?.trim() ? ` "${oneLine(args.title.trim())}"` : "";
			const continuationId = args.continue_session?.trim();
			const summary = continuationId
				? `continue ${oneLine(continuationId)}${title}`
				: `${oneLine(args.agent?.trim() || "(agent required)")}${title}`;
			text.setText(`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", summary)}`);
			return text;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const batch = activeTurnBatch ?? Symbol("delegate-unscoped-call");
			if (subordinationLevel === 0 && !root.closed) root.context = ctx;
			if (root.closed || !root.context) return createDelegateToolResult(resultError("failed", "The root session is unavailable."));
			if (!params.title.trim()) return createDelegateToolResult(resultError("failed", "`title` must be a non-empty string."));
			if (!params.input.trim()) return createDelegateToolResult(resultError("failed", "`input` must be a non-empty string."));
			if (Object.hasOwn(params, "agentPreset") || Object.hasOwn(params, "skills")) return createDelegateToolResult(resultError("failed", "`agentPreset` and caller-supplied `skills` are no longer supported; configure an agent definition and use `agent` when opening."));
			const abortSignal = signal ?? new AbortController().signal;
			const continuationId = params.continue_session?.trim();
			if (continuationId) {
				if (params.agent !== undefined) return createDelegateToolResult(resultError("failed", "Do not specify `agent` when continuing an existing child session."));
				const child = registry.get(continuationId);
				if (!child || child.cwd !== ctx.cwd) return createDelegateToolResult(resultError("failed", "Session ID is unknown, expired, or cwd-mismatched. Use a valid child session ID returned by a previous delegation request, or omit `continue_session` (or leave it empty) to start a new child session."));
				const result = await child.queue.enqueue({ input: params.input, signal: abortSignal, onUpdate, theme: ctx.ui.theme }, batch);
				if (result.status === "completed") result.sessionId = continuationId;
				return createDelegateToolResult(result);
			}

			const rootContext = root.context;
			const rootModel = rootContext.model ? { model: rootContext.model, thinkingLevel: rootContext.thinkingLevel } : undefined;
			let resolvedModel: ModelSettings;
			let definition: AgentSnapshot["definitions"][number];
			try {
				const config = getBaseConfig();
				const name = params.agent?.trim();
				if (!name) throw new Error("`agent` is required when opening a child session.");
				if (!root.snapshot || !root.skills) throw new Error("The agent snapshot is not yet validated against the full skill catalog; wait for the root session to start its first turn.");
				const found = root.snapshot.definitions.find((agent) => agent.name === name);
				if (!found) throw new Error(`Unknown agent ${JSON.stringify(name)}.`);
				definition = found;
				resolvedModel = resolveAgentModel(definition, config, ctx, rootModel, rootContext.modelRegistry);
			} catch (error) {
				return createDelegateToolResult(resultError("failed", error instanceof Error ? error.message : String(error)));
			}
			try {
				const result = await registry.trackOpening(async () => {
					const nestedRegistry = new ChildRegistry();
					let child: ChildSession | undefined;
					let createdSession: AgentSession | undefined;
					let shutdownSession: (() => Promise<void>) | undefined;
					try {
						const setup = (async () => {
							// The root catalog includes hidden and extension-provided skills, which may
							// not yet be present during a child resource loader's initial reload.
							const preloadedSkills = resolvePreloadedSkills(root.skills!, definition.skills.preload);
							const resourceLoader = new DefaultResourceLoader({
								cwd: ctx.cwd,
								agentDir: getAgentDir(),
								extensionsOverride: (current) => ({ ...current, extensions: current.extensions.filter((extension) => extension.path !== sourcePath && extension.resolvedPath !== sourcePath) }),
								extensionFactories: [{ name: "pi-subagent", factory: createExtensionFactory(root, nestedRegistry, sourcePath, subordinationLevel), hidden: true }],
								noPromptTemplates: true,
								noThemes: true,
								// Preserve all skills for explicit /skill:name expansion. Pi uses this
								// flag only to exclude entries from the automatic prompt catalog.
								skillsOverride: definition.skills.allowDiscovery ? undefined : (current) => ({
									...current, skills: current.skills.map((skill) => ({ ...skill, disableModelInvocation: true })),
								}),
								appendSystemPromptOverride: (current) => [...current, ...(definition.prompt.trim() ? [definition.prompt] : []), ...(preloadedSkills.length ? [formatPreloadedSkills(preloadedSkills)] : [])],
							});
							await resourceLoader.reload();
							if (registry.isClosed()) throw new Error("The extension runtime is shutting down.");
							const { session } = await createAgentSession({ cwd: ctx.cwd, model: resolvedModel.model, thinkingLevel: resolvedModel.thinkingLevel, resourceLoader, sessionManager: SessionManager.inMemory(ctx.cwd) });
							createdSession = session;
							shutdownSession = async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); };
							// Bind before the first turn so extension-provided resources are discovered.
							await session.bindExtensions({ mode: "print", onError: (error) => console.warn(`Child extension ${error.extensionPath} (${error.event}): ${error.error}`) });
							// Startup handlers may register more tools; apply restrictions after binding.
							if (definition.tools.length > 0) session.setActiveToolsByName(evaluateToolAccess(definition.tools, session.getAllTools().map((tool) => tool.name)));
							if (registry.isClosed()) throw new Error("The extension runtime is shutting down.");
							child = { session, cwd: ctx.cwd, nestedRegistry, queue: undefined as never, shutdown: shutdownSession };
							child.queue = new ContinuationQueue(session, (request) => runChildRequest(child!, request.input, request.signal, request.onUpdate, request.theme, ctx.cwd));
							registry.add(child);
						})();
						await setup;
						if (!child) throw new Error("Child session setup did not produce a session.");
						const result = await child.queue.startInitial({ input: params.input, signal: abortSignal, onUpdate, theme: ctx.ui.theme }, batch);
						if (result.status !== "completed") { registry.remove(child.session.sessionId, child); await disposeChild(child); return result; }
						result.sessionId = child.session.sessionId;
						return result;
					} catch (error) {
						try {
							if (child) { registry.remove(child.session.sessionId, child); await disposeChild(child); }
							else {
								try { await nestedRegistry.close(); }
								finally {
									try { await shutdownSession?.(); }
									finally { createdSession?.dispose(); }
								}
							}
						} catch (cleanupError) { console.warn(`Could not fully clean up a child session: ${String(cleanupError)}`); }
						return resultError(abortSignal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
					}
				});
				return createDelegateToolResult(result);
			} catch (error) {
				return createDelegateToolResult(resultError(abortSignal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)));
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerExtension(pi, { closed: false }, undefined, extensionSourcePath);
}
