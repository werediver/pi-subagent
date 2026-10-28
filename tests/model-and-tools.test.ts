import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionConfig } from "../src/config.ts";
import {
	AgentPresetError,
	ModelNotFoundError,
	getAgentPresetAvailability,
	resolveAgentPreset,
	type ModelSettings,
} from "../src/model-resolver.ts";
import { evaluateToolAccess, resolveToolAccessRules } from "../src/tool-access.ts";

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

test("concrete models select explicit provider, then main provider, then parent provider", () => {
	const presets = config({ explicit: { model: "shared", provider: "explicit-provider", thinkingLevel: "medium" }, implicit: { model: "shared" } });
	const ctx = context(parent, allModels);
	assert.deepEqual(resolveAgentPreset("explicit", presets, ctx, mainSettings), { model: explicitShared, thinkingLevel: "medium" });
	assert.deepEqual(resolveAgentPreset("implicit", presets, ctx, mainSettings), { model: mainShared, thinkingLevel: undefined });
	assert.deepEqual(resolveAgentPreset("implicit", presets, ctx, undefined), { model: parentShared, thinkingLevel: undefined });
	assert.deepEqual(resolveAgentPreset("explicit", presets, context(undefined, allModels), undefined), { model: explicitShared, thinkingLevel: "medium" });
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

test("availability sorts resolvable custom presets, deduplicates preset diagnostics, and falls back to parent for main", () => {
	const presets = config({
		z: { base: "main" }, a: { base: "parent" },
		bad1: { base: "absent" }, bad2: { base: "absent" },
		missing: { model: "not-registered", provider: "p" },
		parent: { description: "custom description" },
	});
	assert.deepEqual(getAgentPresetAvailability(presets, context(parent), undefined), {
		names: ["parent", "main", "a", "z"],
		diagnostics: ['Unknown agent preset "absent". Configure it in subagent.json.', 'Model p/not-registered for agent preset "missing" was not found.'],
	});
	assert.deepEqual(getAgentPresetAvailability(config({ needsProvider: { model: "x" } }), context(undefined), undefined), { names: [], diagnostics: [] });
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

test("tool rules inherit base-first across presets and derived rules override matching base rules", () => {
	const presets = config({
		base: { model: "m", tools: { "*": false, "read*": true } },
		middle: { base: "base", tools: { read_secret: false, bash: true } },
		child: { base: "middle", tools: { "read*": false, read_file: true } },
	});
	const rules = resolveToolAccessRules(" child ", presets);
	assert.deepEqual(rules, [
		{ pattern: "*", enabled: false }, { pattern: "read*", enabled: true },
		{ pattern: "read_secret", enabled: false }, { pattern: "bash", enabled: true },
		{ pattern: "read*", enabled: false }, { pattern: "read_file", enabled: true },
	]);
	assert.deepEqual(evaluateToolAccess(rules, ["read_file", "read_secret", "bash", "write"]), ["read_file", "bash"]);
});

test("tool resolution treats built-ins as empty and returns rules even for description-only presets", () => {
	const presets = config({ parent: { description: "parent" }, main: { description: "main" }, custom: { description: "description only" }, fromMain: { base: "main", tools: { bash: false } } });
	for (const name of [undefined, "", "  ", "parent", "main", "custom"]) assert.deepEqual(resolveToolAccessRules(name, presets), []);
	assert.deepEqual(resolveToolAccessRules("fromMain", presets), [{ pattern: "bash", enabled: false }]);
});

test("tool resolution reports unknown presets, unknown bases, and circular inheritance", () => {
	const presets = config({ broken: { base: "absent" }, self: { base: "self" }, a: { base: "b" }, b: { base: "a" } });
	for (const [name, message] of [
		["unknown", 'Unknown agent preset "unknown". Configure it in subagent.json.'],
		["broken", 'Unknown agent preset "absent". Configure it in subagent.json.'],
		["self", 'Circular agent preset reference involving "self".'],
		["a", 'Circular agent preset reference involving "a".'],
	] as const) {
		assert.throws(() => resolveToolAccessRules(name, presets), { name: "AgentPresetError", message });
	}
});
