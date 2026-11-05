import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { AgentModelNotFoundError, formatAgentDigest, getAgentAvailability, resolveAgentModel, type ModelSettings } from "../src/model-resolver.ts";
import { evaluateToolAccess } from "../src/tool-access.ts";
import { buildAgentSnapshot, type AgentDefinition } from "../src/agent-definitions.ts";

type ModelContext = Parameters<typeof resolveAgentModel>[1];

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

const callerModel = model("caller-provider", "caller-model");
const rootModel = model("root-provider", "root-model");
const callerShared = model("caller-provider", "shared");
const rootShared = model("root-provider", "shared");
const explicitShared = model("explicit-provider", "shared");
const rootParentNamed = model("root-provider", "parent");
const rootMainNamed = model("root-provider", "main");
const allModels = [callerShared, rootShared, explicitShared, rootParentNamed, rootMainNamed];
const rootSettings: ModelSettings = { model: rootModel, thinkingLevel: "high" };

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return { name: "tester", prompt: "", tools: [], skills: { allowDiscovery: true, preload: [] }, ...overrides };
}

const resolve = (definition: AgentDefinition, ctx: ModelContext, root: ModelSettings | undefined = rootSettings, registry = ctx.modelRegistry) =>
	resolveAgentModel(definition, ctx, root, registry);

test("omitted model inherits the immediate caller model and thinking level", () => {
	const ctx = context(callerModel, allModels);
	assert.deepEqual(resolve(agentDefinition(), ctx), { model: callerModel, thinkingLevel: "low" });
	assert.deepEqual(resolve(agentDefinition({ thinkingLevel: "high" }), ctx), { model: callerModel, thinkingLevel: "high" });
	assert.throws(() => resolve(agentDefinition(), context(undefined), undefined), { message: "The parent session has no active model." });
});

test("frontmatter model names are concrete IDs, including former aliases", () => {
	const ctx = context(callerModel, allModels);
	assert.deepEqual(resolve(agentDefinition({ model: { name: "shared" } }), ctx), { model: rootShared });
	assert.deepEqual(resolve(agentDefinition({ model: { name: "shared", provider: "explicit-provider" } }), ctx), { model: explicitShared });
	assert.deepEqual(resolve(agentDefinition({ model: { name: "parent" } }), ctx), { model: rootParentNamed });
	assert.deepEqual(resolve(agentDefinition({ model: { name: "main" } }), ctx), { model: rootMainNamed });
	assert.deepEqual(resolveAgentModel(agentDefinition({ model: { name: "shared", provider: "explicit-provider" } }), context(undefined, allModels), undefined), { model: explicitShared });
});

test("concrete model lookup uses the live root provider and root registry", () => {
	const caller = context(callerModel, [callerShared]);
	const rootRegistry = context(rootModel, [rootShared]).modelRegistry;
	assert.deepEqual(resolve(agentDefinition({ model: { name: "shared" } }), caller, rootSettings, rootRegistry), { model: rootShared });
	assert.throws(() => resolve(agentDefinition({ model: { name: "shared" } }), caller, rootSettings, context(rootModel, [callerShared]).modelRegistry), AgentModelNotFoundError);
	assert.throws(() => resolveAgentModel(agentDefinition({ model: { name: "shared" } }), caller, undefined), /needs a provider because the root session has no active model/);
});

test("agent availability re-resolves concrete models against live root model and registry", () => {
	const snapshot = buildAgentSnapshot({
		sources: [
			{ filename: "a.md", content: "---\nname: implicit\nmodel: shared\n---\n" },
			{ filename: "b.md", content: "---\nname: inherited\n---\n" },
			{ filename: "c.md", content: "---\nname: former-parent\nmodel: parent\n---\n" },
			{ filename: "d.md", content: "---\nname: fixed\nmodel: shared\nprovider: explicit-provider\n---\n" },
			{ filename: "e.md", content: "---\nname: invalid\nprovider: explicit-provider\n---\n" },
		],
	}, []);
	const caller = context(callerModel, [callerShared]);
	const mutableModels = [rootShared, rootParentNamed, explicitShared];
	const registry = context(rootModel, mutableModels).modelRegistry;
	const names = (root: ModelSettings | undefined) => getAgentAvailability(snapshot, caller, root, registry).map((definition) => definition.name);
	assert.deepEqual(names(rootSettings), ["implicit", "inherited", "former-parent", "fixed"]);
	assert.deepEqual(names({ model: model("other-provider", "other") }), ["inherited", "fixed"]);
	assert.deepEqual(names(undefined), ["inherited", "fixed"]);
	assert.equal(snapshot.diagnostics.length, 1);
	assert.match(snapshot.diagnostics[0].reason, /provider.*alongside.*model/i);

	mutableModels.push(callerShared);
	assert.deepEqual(names({ model: { ...rootModel, provider: "caller-provider" } }), ["implicit", "inherited", "fixed"]);
	assert.deepEqual(snapshot.definitions.map(({ name }) => name), ["implicit", "inherited", "former-parent", "fixed"]);
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

test("digest contains only safely formatted names and optional descriptions", () => {
	const definitions = [
		agentDefinition({ name: `evil\n<&\"'\u001b[31mred\u001b[0m`, description: `first\r\nsecond <tag> & \"'\u0000`, prompt: "SECRET_BODY", model: { name: "secret-model" } }),
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
	assert.doesNotMatch(digest, /SECRET|secret-model|agentPreset|\u001b|\u0000/);
	assert.equal(formatAgentDigest([]), [
		"The following agents are available for the `delegate` tool. Set `agent` to one of these names.",
		"<delegate_agent_options>",
		"",
		"</delegate_agent_options>",
	].join("\n"));
});

test("model errors identify the concrete agent ID and provider", () => {
	assert.throws(() => resolve(agentDefinition({ model: { name: "missing" } }), context(callerModel, allModels)), (error: unknown) => {
		assert.ok(error instanceof AgentModelNotFoundError);
		assert.equal(error.message, 'Model root-provider/missing for agent "tester" was not found in the model registry. Register the model or set the agent\'s provider.');
		return true;
	});
});
