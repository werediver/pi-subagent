import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { AgentModelNotFoundError, AgentProviderAuthNotConfiguredError, formatAgentDigest, getAgentAvailability, resolveAgentModel, type ModelSettings } from "../src/model-resolver.ts";
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

// ModelRegistry is a concrete class with private state; provide only the resolver's registry methods.
function context(
	active: ModelSettings["model"] | undefined,
	models: Model<"openai-completions">[] = [],
	authConfigured: (provider: string) => boolean = () => true,
): ModelContext {
	const registry: Pick<ModelContext["modelRegistry"], "getAll" | "getProviderAuthStatus"> = {
		getAll: () => models,
		getProviderAuthStatus: (provider) => ({ configured: authConfigured(provider) }),
	};
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
	return { filename: "tester.md", name: "tester", prompt: "", tools: [], skills: { allowDiscovery: true, preload: [] }, ...overrides };
}

const resolve = (definition: AgentDefinition, ctx: ModelContext, root: ModelSettings | undefined = rootSettings, registry = ctx.modelRegistry) =>
	resolveAgentModel(definition, ctx, root, registry);

test("omitted model inherits the immediate caller model and thinking level", () => {
	const ctx = context(callerModel, allModels);
	assert.deepEqual(resolve(agentDefinition(), ctx), { model: callerModel, thinkingLevel: "low" });
	assert.deepEqual(resolve(agentDefinition(), { ...ctx, thinkingLevel: "high" }), { model: callerModel, thinkingLevel: "high" });
	assert.throws(() => resolve(agentDefinition(), context(undefined), undefined), { message: "The parent session has no active model." });
});

test("model candidates resolve in order with exact opaque provider and ID matching", () => {
	const ctx = context(callerModel, allModels);
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "shared" }] }), ctx), { model: rootShared });
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "shared", provider: "explicit-provider" }, { id: "shared" }] }), ctx), { model: explicitShared });
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "shared", provider: "explicit-provider" }] }), ctx), { model: explicitShared });
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "shared", provider: "explicit-provider", thinkingLevel: "xhigh" }] }), ctx), { model: explicitShared, thinkingLevel: "xhigh" });
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "parent" }] }), ctx), { model: rootParentNamed });
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "main" }] }), ctx), { model: rootMainNamed });
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "absent" }, { id: "shared", provider: "explicit-provider" }] }), ctx), { model: explicitShared });
	assert.deepEqual(resolveAgentModel(agentDefinition({ model: [{ id: "shared" }, { id: "shared", provider: "explicit-provider" }] }), context(undefined, allModels), undefined), { model: explicitShared });
	const opaque = model("Provider/Name", "Models/ID");
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "Models/ID", provider: "Provider/Name" }] }), context(undefined, [opaque]), undefined), { model: opaque });
});

test("explicit candidates skip unconfigured exact matches and diagnose only when all matches are unconfigured", () => {
	const first = model("first-provider", "first-model");
	const later = model("later-provider", "later-model");
	const calls: string[] = [];
	const ctx = context(rootModel, [first, later], (provider) => {
		calls.push(provider);
		return provider === "later-provider";
	});
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "later-model", provider: "later-provider" }] }), ctx), { model: later });
	assert.deepEqual(calls, ["later-provider"]);

	calls.length = 0;
	assert.deepEqual(
		resolve(agentDefinition({ model: [
			{ id: "first-model", provider: "first-provider", thinkingLevel: "low" },
			{ id: "later-model", provider: "later-provider", thinkingLevel: "xhigh" },
		] }), ctx),
		{ model: later, thinkingLevel: "xhigh" },
		"a configured later candidate resolves with its own thinking level",
	);
	assert.deepEqual(calls, ["first-provider", "later-provider"]);

	calls.length = 0;
	const allUnconfigured = context(rootModel, [first, later], (provider) => { calls.push(provider); return false; });
	assert.throws(
		() => resolve(agentDefinition({ model: [
			{ id: "first-model", provider: "first-provider" },
			{ id: "missing-model", provider: "missing-provider" },
			{ id: "later-model", provider: "later-provider" },
		] }), allUnconfigured),
		(error: unknown) => {
			assert.ok(error instanceof AgentProviderAuthNotConfiguredError);
			assert.match(error.message, /registered, but provider auth is not configured/);
			assert.ok(error.message.includes("/login first-provider"));
			assert.match(error.message, /pi auth check --provider first-provider/);
			return true;
		},
	);
	assert.deepEqual(calls, ["first-provider", "later-provider"], "all exact matches are checked before reporting provider auth");
});

test("explicit candidates with no exact registry matches remain model-not-found", () => {
	assert.throws(
		() => resolve(agentDefinition({ model: [{ id: "missing", provider: "first-provider" }, { id: "also-missing", provider: "later-provider" }] }), context(rootModel, [])),
		(error: unknown) => {
			assert.ok(error instanceof AgentModelNotFoundError);
			assert.ok(!(error instanceof AgentProviderAuthNotConfiguredError));
			return true;
		},
	);
});

test("inherited model resolution does not query provider auth", () => {
	let authChecks = 0;
	const ctx = context(callerModel, [], () => { authChecks++; return false; });
	assert.deepEqual(resolve(agentDefinition(), ctx), { model: callerModel, thinkingLevel: "low" });
	assert.equal(authChecks, 0);
});

test("mixed string and mapping entries resolve in their declared order", () => {
	const snapshot = buildAgentSnapshot({ sources: [
		{ filename: "string-first.md", content: "---\nname: string-first\nmodel:\n  - shared\n  - { id: shared, provider: explicit-provider, thinkingLevel: high }\n---\n" },
		{ filename: "mapping-first.md", content: "---\nname: mapping-first\nmodel:\n  - { id: shared, provider: explicit-provider, thinkingLevel: high }\n  - shared\n---\n" },
	] }, []);
	assert.deepEqual(snapshot.diagnostics, []);
	assert.deepEqual(snapshot.definitions.map(({ model: candidates }) => candidates), [
		[{ id: "shared" }, { id: "shared", provider: "explicit-provider", thinkingLevel: "high" }],
		[{ id: "shared", provider: "explicit-provider", thinkingLevel: "high" }, { id: "shared" }],
	]);
	const ctx = context(callerModel, allModels);
	assert.deepEqual(resolve(snapshot.definitions[0], ctx), { model: rootShared }, "a later candidate's thinking level does not apply when the earlier string matches");
	assert.deepEqual(resolve(snapshot.definitions[1], ctx), { model: explicitShared, thinkingLevel: "high" });
});

test("concrete model lookup uses the live root provider and root registry", () => {
	const caller = context(callerModel, [callerShared]);
	const rootRegistry = context(rootModel, [rootShared]).modelRegistry;
	assert.deepEqual(resolve(agentDefinition({ model: [{ id: "shared" }] }), caller, rootSettings, rootRegistry), { model: rootShared });
	assert.throws(() => resolve(agentDefinition({ model: [{ id: "shared" }] }), caller, rootSettings, context(rootModel, [callerShared]).modelRegistry), AgentModelNotFoundError);
	assert.throws(() => resolveAgentModel(agentDefinition({ model: [{ id: "shared" }] }), caller, undefined), /\"<no root provider>\"\/\"shared\"/);
});

test("agent availability re-resolves concrete models against live root model and registry", () => {
	const snapshot = buildAgentSnapshot({
		sources: [
			{ filename: "a.md", content: "---\nname: implicit\nmodel: shared\n---\n" },
			{ filename: "b.md", content: "---\nname: inherited\n---\n" },
			{ filename: "c.md", content: "---\nname: former-parent\nmodel: parent\n---\n" },
			{ filename: "d.md", content: "---\nname: fixed\nmodel: { id: shared, provider: explicit-provider }\n---\n" },
			{ filename: "e.md", content: "---\nname: invalid\nprovider: explicit-provider\n---\n" },
			{ filename: "f.md", content: "---\nname: fallback\nmodel:\n  - id: absent\n  - id: shared\n    provider: explicit-provider\n---\n" },
			{ filename: "g.md", content: "---\nname: needs-root\nmodel: root-only\n---\n" },
		],
	}, []);
	const caller = context(callerModel, [callerShared]);
	const mutableModels = [rootShared, rootParentNamed, explicitShared];
	const registry = context(rootModel, mutableModels).modelRegistry;
	const names = (root: ModelSettings | undefined) => getAgentAvailability(snapshot, caller, root, registry).map((definition) => definition.name);
	assert.deepEqual(names(rootSettings), ["implicit", "inherited", "former-parent", "fixed", "fallback"]);
	assert.deepEqual(names({ model: model("other-provider", "other") }), ["inherited", "fixed", "fallback"]);
	assert.deepEqual(names(undefined), ["inherited", "fixed", "fallback"]);
	assert.equal(snapshot.diagnostics.length, 1);
	assert.match(snapshot.diagnostics[0].reason, /top-level provider is no longer supported/);

	mutableModels.push(callerShared);
	assert.deepEqual(names({ model: { ...rootModel, provider: "caller-provider" } }), ["implicit", "inherited", "fixed", "fallback"]);
	assert.deepEqual(snapshot.definitions.map(({ name }) => name), ["implicit", "inherited", "former-parent", "fixed", "fallback", "needs-root"]);
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
		agentDefinition({ name: `evil\n<&\"'\u001b[31mred\u001b[0m`, description: `first\r\nsecond <tag> & \"'\u0000`, prompt: "SECRET_BODY", model: [{ id: "secret-model" }] }),
		agentDefinition({ name: "plain", prompt: "OTHER_SECRET_BODY" }),
	];
	const digest = formatAgentDigest(definitions);
	assert.doesNotMatch(formatAgentDigest([agentDefinition({ filename: "source-path.md" })]), /source-path/);
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

test("model errors list every attempted provider and ID separately quoted", () => {
	assert.throws(() => resolve(agentDefinition({ model: [{ id: "missing" }, { id: "also-missing", provider: "explicit-provider" }] }), context(callerModel, allModels)), (error: unknown) => {
		assert.ok(error instanceof AgentModelNotFoundError);
		assert.equal(error.message, 'None of the model candidates for agent "tester" were found in the live model registry. Attempted: "root-provider"/"missing", "explicit-provider"/"also-missing". Register the models or update the agent\'s model candidates.');
		return true;
	});
});
