import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionConfig } from "../src/config.ts";
import {
	AgentModelNotFoundError,
	AgentPresetError,
	ModelNotFoundError,
	formatAgentDigest,
	getAgentAvailability,
	resolveAgentModel,
	resolveAgentPreset,
	type ModelSettings,
} from "../src/model-resolver.ts";
import { evaluateToolAccess } from "../src/tool-access.ts";
import { buildAgentSnapshot, type AgentDefinition } from "../src/agent-definitions.ts";

type ModelContext = Parameters<typeof resolveAgentPreset>[2];

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		provider, id, name: id, api: "openai-completions", baseUrl: "https://example.test",
		reasoning: true, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000, maxTokens: 100,
	};
}

// The resolver uses only getAll(); ModelRegistry is a concrete class with private state.
function context(active: ModelSettings["model"] | undefined, models: Model<"openai-completions">[] = []): ModelContext {
	const registry: Pick<ModelContext["modelRegistry"], "getAll"> = { getAll: () => models };
	return { model: active, thinkingLevel: "low", modelRegistry: registry as ModelContext["modelRegistry"] };
}

const parent = model("parent-provider", "parent-model");
const main = model("main-provider", "main-model");
const parentShared = model("parent-provider", "shared");
const mainShared = model("main-provider", "shared");
const explicitShared = model("explicit-provider", "shared");
const allModels = [parentShared, mainShared, explicitShared];
const mainSettings: ModelSettings = { model: main, thinkingLevel: "high" };

function config(agentPresets: ExtensionConfig["agentPresets"] = {}): ExtensionConfig {
	return { agentPresets };
}

test("parent is the default for omitted, blank, and trimmed preset names; main uses supplied settings", () => {
	const ctx = context(parent);
	for (const name of [undefined, "", "  ", " parent "]) {
		assert.deepEqual(resolveAgentPreset(name, config(), ctx, mainSettings), { model: parent, thinkingLevel: "low" });
	}
	assert.strictEqual(resolveAgentPreset(" main ", config(), ctx, mainSettings), mainSettings);
});

test("concrete models select explicit provider or the root provider, never the caller provider", () => {
	const presets = config({ explicit: { model: "shared", provider: "explicit-provider", thinkingLevel: "medium" }, implicit: { model: "shared" } });
	const ctx = context(parent, allModels);
	assert.deepEqual(resolveAgentPreset("explicit", presets, ctx, mainSettings), { model: explicitShared, thinkingLevel: "medium" });
	assert.deepEqual(resolveAgentPreset("implicit", presets, ctx, mainSettings), { model: mainShared, thinkingLevel: undefined });
	assert.throws(() => resolveAgentPreset("implicit", presets, ctx, undefined), /root session has no active model/);
	assert.deepEqual(resolveAgentPreset("explicit", presets, context(undefined, allModels), undefined), { model: explicitShared, thinkingLevel: "medium" });
});

test("model availability uses the root registry rather than the calling session registry", () => {
	const presets = config({ implicit: { model: "shared" } });
	const caller = context(parent, [parentShared]);
	const rootRegistry = context(main, [mainShared]).modelRegistry;
	assert.deepEqual(resolveAgentPreset("implicit", presets, caller, mainSettings, rootRegistry), { model: mainShared, thinkingLevel: undefined });
	assert.throws(() => resolveAgentPreset("implicit", presets, caller, mainSettings, context(main, [parentShared]).modelRegistry), ModelNotFoundError);
});

test("base presets inherit models and custom thinking levels, but not built-in thinking levels", () => {
	const presets = config({
		fromParent: { base: "parent" },
		fromMain: { base: "main" },
		overrideParent: { base: "parent", thinkingLevel: "medium" },
		concrete: { model: "shared", provider: "explicit-provider", thinkingLevel: "high" },
		derived: { base: "concrete" },
		override: { base: "derived", thinkingLevel: "off" },
		indirectParent: { base: "overrideParent" },
	});
	const ctx = context(parent, allModels);
	const resolve = (name: string) => resolveAgentPreset(name, presets, ctx, mainSettings);
	assert.deepEqual(resolve("fromParent"), { model: parent, thinkingLevel: undefined });
	assert.deepEqual(resolve("fromMain"), { model: main, thinkingLevel: undefined });
	assert.deepEqual(resolve("overrideParent"), { model: parent, thinkingLevel: "medium" });
	assert.deepEqual(resolve("indirectParent"), { model: parent, thinkingLevel: "medium" });
	assert.deepEqual(resolve("derived"), { model: explicitShared, thinkingLevel: "high" });
	assert.deepEqual(resolve("override"), { model: explicitShared, thinkingLevel: "off" });
});

test("model resolution reports missing sessions, providers, presets, and models", () => {
	const ctx = context(undefined);
	const presets = config({ missingProvider: { model: "shared" }, missingModel: { model: "missing", provider: "p" }, descriptionOnly: { description: "not a model" } });
	assert.throws(() => resolveAgentPreset(undefined, presets, ctx, undefined), { name: "Error", message: "The parent session has no active model." });
	assert.throws(() => resolveAgentPreset("main", presets, ctx, undefined), { name: "Error", message: "The main session has no active model." });
	assert.throws(() => resolveAgentPreset("missingProvider", presets, ctx, undefined), { name: "Error", message: 'Agent preset "missingProvider" needs a provider because the root session has no active model.' });
	assert.throws(() => resolveAgentPreset("unknown", presets, ctx, undefined), { name: "AgentPresetError", message: 'Unknown agent preset "unknown". Configure it in subagent.json.' });
	assert.throws(() => resolveAgentPreset("descriptionOnly", presets, ctx, undefined), { name: "AgentPresetError", message: 'Agent preset "descriptionOnly" must define a model or a base preset.' });
	assert.throws(() => resolveAgentPreset("missingModel", presets, ctx, undefined), (error: unknown) => {
		assert.ok(error instanceof ModelNotFoundError);
		assert.ok(error instanceof AgentPresetError);
		assert.equal(error.message, 'Model p/missing for agent preset "missingModel" was not found.');
		return true;
	});
});

test("model resolution detects self and indirect cycles and unknown bases", () => {
	const presets = config({ self: { base: "self" }, a: { base: "b" }, b: { base: "a" }, broken: { base: "absent" } });
	const ctx = context(parent);
	for (const [name, message] of [
		["self", 'Circular agent preset reference involving "self".'],
		["a", 'Circular agent preset reference involving "a".'],
		["broken", 'Unknown agent preset "absent". Configure it in subagent.json.'],
	] as const) {
		assert.throws(() => resolveAgentPreset(name, presets, ctx, mainSettings), { name: "AgentPresetError", message });
	}
});

test("tool rules default to enabled, preserve available order, and apply last match", () => {
	const names = ["read", "write", "bash", "web_search"];
	assert.deepEqual(evaluateToolAccess([], names), names);
	assert.notStrictEqual(evaluateToolAccess([], names), names);
	assert.deepEqual(evaluateToolAccess([
		{ pattern: "*", enabled: false },
		{ pattern: "w*", enabled: true },
		{ pattern: "write", enabled: false },
		{ pattern: "bash", enabled: true },
	], names), ["bash", "web_search"]);
	assert.deepEqual(evaluateToolAccess([{ pattern: "read", enabled: false }], names), ["write", "bash", "web_search"]);
});

test("tool patterns are case-sensitive, whole-name globs with literal regex metacharacters", () => {
	const names = ["read", "Read", "bread", "read_more", "a.b", "axb", "tool[1]", "tool1", "preMIDpost", "prepost", "preMIDpostX"];
	assert.deepEqual(evaluateToolAccess([
		{ pattern: "read", enabled: false },
		{ pattern: "a.b", enabled: false },
		{ pattern: "tool[1]", enabled: false },
		{ pattern: "pre*post", enabled: false },
	], names), ["Read", "bread", "read_more", "axb", "tool1", "preMIDpostX"]);
});

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return { name: "tester", prompt: "", tools: [], skills: { allowDiscovery: true, preload: [] }, ...overrides };
}

const resolve = (definition: AgentDefinition, presets: ExtensionConfig, ctx: ModelContext, main: ModelSettings | undefined = mainSettings, registry = ctx.modelRegistry) =>
	resolveAgentModel(definition, presets, ctx, main, registry);

test("agents with omitted models inherit the calling session, with explicit thinkingLevel overriding it", () => {
	const ctx = context(parent, allModels);
	assert.deepEqual(resolve(agentDefinition(), config(), ctx), { model: parent, thinkingLevel: "low" });
	assert.deepEqual(resolve(agentDefinition({ thinkingLevel: "high" }), config(), ctx), { model: parent, thinkingLevel: "high" });
	assert.throws(() => resolve(agentDefinition({ thinkingLevel: "high" }), config(), context(undefined), undefined), /The parent session has no active model/);
});

test("agents with preset models resolve through preset ancestry and agent thinkingLevel overrides the preset", () => {
	const presets = config({
		preview: { model: "shared", provider: "explicit-provider", thinkingLevel: "medium" },
		rooted: { base: "main", thinkingLevel: "xhigh" },
	});
	const ctx = context(parent, allModels);
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "preset", name: "preview" } }), presets, ctx), { model: explicitShared, thinkingLevel: "medium" });
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "preset", name: "preview" }, thinkingLevel: "off" }), presets, ctx), { model: explicitShared, thinkingLevel: "off" });
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "preset", name: "main" } }), presets, ctx), mainSettings);
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "preset", name: "rooted" } }), presets, ctx), { model: main, thinkingLevel: "xhigh" });
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "preset", name: "parent" } }), presets, ctx), { model: parent, thinkingLevel: "low" });
	assert.throws(() => resolve(agentDefinition({ model: { kind: "preset", name: "absent" } }), presets, ctx), { name: "AgentPresetError", message: 'Unknown agent preset "absent". Configure it in subagent.json.' });
});

test("agents with concrete model IDs resolve from the root provider unless the provider is explicit", () => {
	const ctx = context(parent, allModels);
	// Implicit provider: the root (main) provider, never the caller provider.
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "id", name: "shared" } }), config(), ctx), { model: mainShared });
	// Explicit provider and agent thinkingLevel override.
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "id", name: "shared", provider: "explicit-provider" }, thinkingLevel: "max" }), config(), ctx), { model: explicitShared, thinkingLevel: "max" });
	// Availability checks use the root registry, not the calling session's registry.
	const caller = context(parent, [parentShared]);
	assert.deepEqual(resolve(agentDefinition({ model: { kind: "id", name: "shared" } }), config(), caller, mainSettings, context(main, [mainShared]).modelRegistry), { model: mainShared });
	assert.throws(() => resolve(agentDefinition({ model: { kind: "id", name: "shared" } }), config(), caller, mainSettings, context(main, [parentShared]).modelRegistry), AgentModelNotFoundError);
});

test("agent availability re-resolves the immutable snapshot against live root model and registry", () => {
	const snapshot = buildAgentSnapshot({
		config: config({ configured: { model: "shared", description: "preset metadata" } }),
		sources: [
			{ filename: "z.md", content: "---\nname: implicit\nmodel: shared\n---\nprivate body" },
			{ filename: "a.md", content: "---\nname: inherited\n---\n" },
			{ filename: "b.md", content: "---\nname: preset\nmodel: configured\n---\n" },
			{ filename: "c.md", content: "---\nname: root\nmodel: main\n---\n" },
			{ filename: "d.md", content: "---\nname: fixed\nmodel: shared\nprovider: explicit-provider\n---\n" },
			{ filename: "rejected.md", content: "---\nname: rejected\ntools: invalid\n---\n" },
		],
	}, []);
	const original = structuredClone(snapshot);
	const caller = context(parent, [parentShared]);
	const liveModels = [mainShared, explicitShared];
	const rootRegistry = context(main, liveModels).modelRegistry;
	const names = (root: ModelSettings | undefined) => getAgentAvailability(snapshot, caller, root, rootRegistry).map((agent) => agent.name);
	assert.deepEqual(names(mainSettings), ["implicit", "inherited", "preset", "root", "fixed"]);
	assert.deepEqual(names({ model: parent }), ["inherited", "root", "fixed"]);
	assert.deepEqual(names(undefined), ["inherited", "fixed"]);

	// A known but unavailable agent stays in the snapshot and reports a model error;
	// unknown and statically rejected names have no definition to resolve.
	const known = snapshot.definitions.find((definition) => definition.name === "implicit");
	assert.ok(known);
	assert.throws(() => resolveAgentModel(known, snapshot.config, caller, { model: parent }, rootRegistry), AgentModelNotFoundError);
	assert.equal(snapshot.definitions.find((definition) => definition.name === "unknown"), undefined);
	assert.equal(snapshot.definitions.find((definition) => definition.name === "rejected"), undefined);
	assert.equal(snapshot.diagnostics.length, 1);

	// Registry changes also affect subsequent checks, and default to the caller registry.
	liveModels.push(parentShared);
	assert.deepEqual(names({ model: parent }), ["implicit", "inherited", "preset", "root", "fixed"]);
	liveModels.splice(0, 1);
	assert.deepEqual(names(mainSettings), ["inherited", "root", "fixed"]);
	liveModels.unshift(mainShared);
	assert.deepEqual(names(mainSettings), ["implicit", "inherited", "preset", "root", "fixed"]);
	assert.deepEqual(getAgentAvailability(snapshot, caller, mainSettings).map((agent) => agent.name), ["inherited", "root"]);
	assert.deepEqual(snapshot, original);
	assert.ok(Object.isFrozen(snapshot.definitions));
	assert.strictEqual(getAgentAvailability(snapshot, caller, mainSettings, rootRegistry)[0], known);
});

test("digest contains only safely formatted names and optional descriptions", () => {
	const definitions = [
		agentDefinition({ name: `evil\n<&\"'\u001b[31mred\u001b[0m`, description: `first\r\nsecond <tag> & \"'\u0000`, prompt: "SECRET_BODY", model: { kind: "preset", name: "secret-preset" } }),
		agentDefinition({ name: "plain", prompt: "OTHER_SECRET_BODY" }),
	];
	const digest = formatAgentDigest(definitions);
	assert.equal(digest, [
		"The following agents are available for the `delegate` tool. Set `agent` to one of these names.",
		"<delegate_agent_options>",
		"- &quot;evil &lt;&amp;\\&quot;&apos;red&quot;: first second &lt;tag&gt; &amp; &quot;&apos;",
		"- &quot;plain&quot;",
		"</delegate_agent_options>",
	].join("\n"));
	assert.doesNotMatch(digest, /SECRET|secret-preset|agentPreset|\u001b|\u0000/);
	assert.equal(formatAgentDigest([]), [
		"The following agents are available for the `delegate` tool. Set `agent` to one of these names.",
		"<delegate_agent_options>",
		"",
		"</delegate_agent_options>",
	].join("\n"));
});

test("agent model errors are actionable and distinct from preset errors", () => {
	const ctx = context(parent, allModels);
	assert.throws(() => resolve(agentDefinition({ model: { kind: "id", name: "missing" } }), config(), ctx), (error: unknown) => {
		assert.ok(error instanceof AgentModelNotFoundError);
		assert.equal(error.message, 'Model main-provider/missing for agent "tester" was not found in the model registry. Register the model or set the agent\'s provider.');
		return true;
	});
	assert.throws(() => resolveAgentModel(agentDefinition({ model: { kind: "id", name: "shared" } }), config(), context(undefined, allModels), undefined), { name: "Error", message: 'Agent "tester" needs a provider because the root session has no active model.' });
});
