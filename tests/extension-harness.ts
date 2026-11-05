import type { Model } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, ToolDefinition, Skill } from "@earendil-works/pi-coding-agent";
import type { DelegateCmdParams } from "../src/index.ts";
import registerExtension from "../src/index.ts";

export function fakeModel(provider = "test-provider", id = "test-model"): Model<"openai-completions"> {
	return {
		provider, id, name: id, api: "openai-completions", baseUrl: "https://example.test", reasoning: true,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
	};
}

/** Minimal, mutable context: intentionally throws if code tries to use an unstubbed API. */
export function fakeContext(cwd: string, models = [fakeModel()]) {
	const notifications: { message: string; level: string | undefined }[] = [];
	const ctx = {
		cwd, isProjectTrusted: () => true, hasUI: true,
		model: models[0], thinkingLevel: "low",
		modelRegistry: { getAll: () => models },
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }), theme: {} },
	} as unknown as ExtensionContext;
	return { ctx, notifications };
}

/** Captures registered callbacks and the tool without needing a live Pi session or provider. */
export function createExtensionHarness(factory: (pi: ExtensionAPI) => void = registerExtension) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let tool: ToolDefinition<any> | undefined;
	const pi = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => { handlers.set(name, handler); },
		registerTool: (definition: ToolDefinition<any>) => { tool = definition; },
	} as unknown as ExtensionAPI;
	factory(pi);
	if (!tool) throw new Error("Extension did not register a tool");
	const delegate = tool;
	return {
		tool: delegate,
		emit: async (name: string, event: unknown, ctx: ExtensionContext) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error("No handler for " + name);
			return handler(event, ctx);
		},
		beforeStart: (ctx: ExtensionContext, selectedTools: string[], systemPrompt = "base prompt", skills: Skill[] = []): BeforeAgentStartEventResult | undefined => {
			const handler = handlers.get("before_agent_start");
			if (!handler) throw new Error("No before_agent_start handler");
			const event = { type: "before_agent_start", prompt: "test", systemPrompt, systemPromptOptions: { selectedTools, skills } } as BeforeAgentStartEvent;
			return handler(event, ctx);
		},
		execute: (ctx: ExtensionContext, params: DelegateCmdParams, signal?: AbortSignal) => delegate.execute("test-call", params, signal, undefined, ctx),
	};
}
