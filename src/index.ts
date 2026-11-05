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
	sources?: AgentSources;
	snapshot?: AgentSnapshot;
	skills?: readonly Skill[];
};

function createExtensionFactory(root: RootSharedState, registry: ChildRegistry, sourcePath: string, callerSubordinationLevel: number): (pi: ExtensionAPI) => void {
	return (pi) => registerExtension(pi, root, registry, sourcePath, callerSubordinationLevel + 1);
}

function registerExtension(pi: ExtensionAPI, root: RootSharedState, registry = new ChildRegistry(), sourcePath = extensionSourcePath, subordinationLevel = 0): void {
	// Pi emits these around one assistant response and its complete tool-call batch.
	let activeTurnBatch: symbol | undefined;
	pi.on("turn_start", () => { activeTurnBatch = Symbol("delegate-turn"); });
	pi.on("turn_end", () => { activeTurnBatch = undefined; });
	const notifiedInitializationWarnings = new Set<string>();
	const reportInitializationError = (ctx: ExtensionContext, error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		if (notifiedInitializationWarnings.has(detail)) return;
		notifiedInitializationWarnings.add(detail);
		const message = `Could not initialize agent definitions: ${detail}`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.warn(message);
	};
	const captureRootSources = (ctx: ExtensionContext): AgentSources => {
		if (!root.sources) root.sources = captureAgentSources({ cwd: ctx.cwd, agentDir: getAgentDir(), trusted: ctx.isProjectTrusted() });
		return root.sources;
	};
	if (subordinationLevel === 0) {
		const updateRootContext = (_event: unknown, ctx: ExtensionContext) => { if (!root.closed) root.context = ctx; };
		pi.on("session_start", (event, ctx) => {
			updateRootContext(event, ctx);
			if (!root.closed) try { captureRootSources(ctx); } catch (error) { reportInitializationError(ctx, error); }
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
				} catch (error) { reportInitializationError(ctx, error); }
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
			const abortSignal = signal ?? new AbortController().signal;
			const continuationId = params.continue_session?.trim();
			const getValidationError = (): string | undefined => {
				if (!params.title.trim()) return "`title` must be a non-empty string.";
				if (!params.input.trim()) return "`input` must be a non-empty string.";
				if (Object.hasOwn(params, "agentPreset") || Object.hasOwn(params, "skills")) return "`agentPreset` and caller-supplied `skills` are no longer supported; configure an agent definition and use `agent` when opening.";
				if (continuationId && params.agent !== undefined) return "Do not specify `agent` when continuing an existing child session.";
				return undefined;
			};
			if (continuationId) {
				const child = registry.get(continuationId);
				if (!child || child.cwd !== ctx.cwd) return createDelegateToolResult(resultError("failed", "Session ID is unknown, expired, or cwd-mismatched. Use a valid child session ID returned by a previous delegation request, or omit `continue_session` (or leave it empty) to start a new child session."));
				const validationError = getValidationError();
				if (validationError) {
					const failure = await child.queue.enqueueFailure(resultError("failed", validationError), abortSignal, batch);
					return createDelegateToolResult(failure);
				}
				const result = await child.queue.enqueue({ input: params.input, signal: abortSignal, onUpdate, theme: ctx.ui.theme }, batch);
				if (result.status === "completed") result.sessionId = continuationId;
				return createDelegateToolResult(result);
			}
			const validationError = getValidationError();
			if (validationError) return createDelegateToolResult(resultError("failed", validationError));
			if (abortSignal.aborted) return createDelegateToolResult(resultError("cancelled", "Delegation was cancelled."));
			if (registry.isClosed()) return createDelegateToolResult(resultError("failed", "The extension runtime is shutting down."));

			const rootContext = root.context;
			const rootModel = rootContext.model ? { model: rootContext.model, thinkingLevel: rootContext.thinkingLevel } : undefined;
			let resolvedModel: ModelSettings;
			let definition: AgentSnapshot["definitions"][number];
			try {
				const name = params.agent?.trim();
				if (!name) throw new Error("`agent` is required when opening a child session.");
				if (!root.snapshot || !root.skills) throw new Error("The agent snapshot is not yet validated against the full skill catalog; wait for the root session to start its first turn.");
				const found = root.snapshot.definitions.find((agent) => agent.name === name);
				if (!found) throw new Error(`Unknown agent ${JSON.stringify(name)}.`);
				definition = found;
				resolvedModel = resolveAgentModel(definition, ctx, rootModel, rootContext.modelRegistry);
			} catch (error) {
				return createDelegateToolResult(resultError("failed", error instanceof Error ? error.message : String(error)));
			}
			try {
				let setupFinished = false;
				let finishSetup!: () => void;
				const setupReady = new Promise<void>((resolve) => {
					finishSetup = () => {
						if (setupFinished) return;
						setupFinished = true;
						resolve();
					};
				});
				let resolveSetupCancellation!: () => void;
				const setupCancellation = new Promise<"cancelled">((resolve) => { resolveSetupCancellation = () => resolve("cancelled"); });
				const onAbortDuringSetup = () => { if (!setupFinished) resolveSetupCancellation(); };
				const opening = registry.trackOpening(async () => {
					const nestedRegistry = new ChildRegistry();
					let child: ChildSession | undefined;
					let createdSession: AgentSession | undefined;
					let shutdownSession: (() => Promise<void>) | undefined;
					const checkOpeningActive = () => {
						if (abortSignal.aborted) throw new Error("Delegation was cancelled.");
						if (registry.isClosed()) throw new Error("The extension runtime is shutting down.");
					};
					try {
						checkOpeningActive();
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
						// Pi's setup APIs accept no AbortSignal: these checkpoints are cooperative,
						// and the tracked opening/shutdown must await any in-flight stage.
						await resourceLoader.reload();
						checkOpeningActive();
						const { session } = await createAgentSession({ cwd: ctx.cwd, model: resolvedModel.model, thinkingLevel: resolvedModel.thinkingLevel, resourceLoader, sessionManager: SessionManager.inMemory(ctx.cwd) });
						createdSession = session;
						shutdownSession = async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); };
						checkOpeningActive();
						// Bind before the first turn so extension-provided resources are discovered.
						await session.bindExtensions({ mode: "print", onError: (error) => console.warn(`Child extension ${error.extensionPath} (${error.event}): ${error.error}`) });
						checkOpeningActive();
						// Startup handlers may register more tools; apply restrictions after binding.
						if (definition.tools.length > 0) session.setActiveToolsByName(evaluateToolAccess(definition.tools, session.getAllTools().map((tool) => tool.name)));
						checkOpeningActive();
						child = {
							session,
							cwd: ctx.cwd,
							nestedRegistry,
							queue: new ContinuationQueue((request) => runChildRequest(child!, request.input, request.signal, request.onUpdate, request.theme, ctx.cwd), session),
							shutdown: shutdownSession,
						};
						checkOpeningActive();
						registry.add(child);
						// From registration on, the queue owns cancellation semantics. The caller
						// must not race the initial request result against its signal anymore.
						finishSetup();
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
					} finally { finishSetup(); }
				});
				abortSignal.addEventListener("abort", onAbortDuringSetup, { once: true });
				if (abortSignal.aborted) onAbortDuringSetup();
				const setupOutcome = await Promise.race([
					setupReady.then(() => "ready" as const),
					opening.then(() => "finished" as const, () => "finished" as const),
					setupCancellation,
				]);
				abortSignal.removeEventListener("abort", onAbortDuringSetup);
				if (setupOutcome === "cancelled") return createDelegateToolResult(resultError("cancelled", "Delegation was cancelled."));
				const result = await opening;
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
