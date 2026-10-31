import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type Skill } from "@earendil-works/pi-coding-agent";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
import { loadExtensionConfig, parseExtensionConfig } from "../src/config.ts";
import { createExtensionHarness, fakeContext, fakeModel } from "./extension-harness.ts";

function withSandbox(run: (project: string, agentDir: string) => void | Promise<void>) {
	return async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-extension-test-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(agentDir);
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try { await run(project, agentDir); }
		finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
			rmSync(root, { recursive: true, force: true });
		}
	};
}

function writeConfig(dir: string, value: unknown) {
	writeFileSync(join(dir, "subagent.json"), JSON.stringify(value));
}

test("configuration parses model/base presets, text and ordered rules", () => {
	assert.deepEqual(parseExtensionConfig({
		subagentPreamble: ["first ", "second"],
		agentPresets: {
			parent: { description: "Parent" },
			fast: { model: " model ", provider: " provider ", thinkingLevel: "low", tools: { "*": false, read: true } },
			derived: { base: " fast ", description: ["one", "two"] },
		},
	}, "test.json"), {
		subagentPreamble: "first\nsecond",
		agentPresets: {
			parent: { description: "Parent" },
			fast: { model: "model", provider: "provider", thinkingLevel: "low", tools: { "*": false, read: true } },
			derived: { base: "fast", description: "one\ntwo" },
		},
	});
});

test("configuration rejects invalid preset fields and rule shapes", () => {
	for (const preset of [
		{ model: "m", base: "parent" }, { model: "" }, { base: "main", provider: "p" },
		{ model: "m", tools: { bash: "false" } }, { model: "m", tools: { " ": false } },
		{ model: "m", thinkingLevel: "very-high" }, { model: "m", unexpected: true },
	]) assert.throws(() => parseExtensionConfig({ agentPresets: { x: preset } }, "test.json"));
	assert.throws(() => parseExtensionConfig({ agentPresets: { parent: { model: "m" } } }, "test.json"));
});

test("configuration merges project over user only when trusted", withSandbox((project, agentDir) => {
	writeConfig(agentDir, { agentPresets: { shared: { model: "user" }, user: { base: "main" } }, subagentPreamble: "user" });
	writeConfig(join(project, CONFIG_DIR_NAME), { agentPresets: { shared: { model: "project" } }, subagentPreamble: "project" });
	const getConfig = (trusted: boolean) => loadExtensionConfig({ cwd: project, isProjectTrusted: () => trusted });
	assert.deepEqual(getConfig(true), { agentPresets: { shared: { model: "project" }, user: { base: "main" } }, subagentPreamble: "project" });
	assert.deepEqual(getConfig(false), { agentPresets: { shared: { model: "user" }, user: { base: "main" } }, subagentPreamble: "user" });
}));

test("root context follows lifecycle events, even with delegate inactive, and stops on shutdown", withSandbox(async (project, agentDir) => {
	writeConfig(agentDir, { agentPresets: { dynamic: { model: "shared", description: "Dynamic choice" } } });
	const first = fakeModel("first", "root");
	const second = fakeModel("second", "root");
	const target = fakeModel("second", "shared");
	const { ctx } = fakeContext(project, [first, second, target]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.doesNotMatch(harness.beforeStart(ctx, ["delegate"])!.systemPrompt!, /Dynamic choice/);
	Object.assign(ctx, { model: second });
	await harness.emit("model_select", { type: "model_select", model: second, previousModel: first, source: "set" }, ctx);
	await harness.emit("thinking_level_select", { type: "thinking_level_select", level: "high", previousLevel: "low" }, ctx);
	assert.equal(harness.beforeStart(ctx, []), undefined);
	assert.match(harness.beforeStart(ctx, ["delegate"])!.systemPrompt!, /Dynamic choice/);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	const result = await harness.execute(ctx, { title: "test", input: "test" });
	assert.deepEqual(result.details, { status: "failed", error: "The root session is unavailable." });
}));

test("root snapshots definitions once, validates against full skills, and refreshes after shutdown", withSandbox(async (project, agentDir) => {
	const dir = join(agentDir, "agents");
	mkdirSync(dir);
	const definition = join(dir, "agent.md");
	writeFileSync(definition, "---\nname: first\nunknown: ignored\nskills: { preload: [hidden] }\n---\nBody");
	writeConfig(agentDir, { agentPresets: { initial: { base: "parent", description: "Initial preset" } } });
	const { ctx, notifications } = fakeContext(project);
	const hidden = { name: "hidden", disableModelInvocation: true } as Skill;
	const first = createExtensionHarness();
	await first.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	// Changes after session startup, but before the first turn, require reload.
	writeFileSync(definition, "---\nname: second\nskills: { preload: [missing] }\n---\n");
	writeConfig(agentDir, { agentPresets: { refreshed: { base: "parent", description: "Refreshed preset" } } });
	// Validation completes after resource discovery even when delegate is inactive.
	assert.equal(first.beforeStart(ctx, [], "prompt", [hidden]), undefined);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /agent\.md.*unknown/);
	const prompt = first.beforeStart(ctx, ["delegate"], "prompt", [])!.systemPrompt!;
	assert.match(prompt, /Initial preset/);
	assert.doesNotMatch(prompt, /Refreshed preset/);
	assert.equal(notifications.length, 1, "no rescanning or duplicate warnings");
	await first.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	const next = createExtensionHarness();
	const refreshed = next.beforeStart(ctx, ["delegate"], "prompt", [])!.systemPrompt!;
	assert.match(refreshed, /Refreshed preset/);
	assert.doesNotMatch(refreshed, /Initial preset/);
	assert.equal(notifications.length, 2);
	assert.match(notifications[1].message, /agent\.md.*unknown preloaded skill.*missing/);
	await next.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));

test("definition diagnostics remain visible without a UI", withSandbox(async (project, agentDir) => {
	const dir = join(agentDir, "agents");
	mkdirSync(dir);
	writeFileSync(join(dir, "invalid.md"), "---\nname: [invalid]\n---\n");
	const { ctx, notifications } = fakeContext(project);
	Object.assign(ctx, { hasUI: false });
	const harness = createExtensionHarness();
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: unknown) => { warnings.push(String(message)); };
	try {
		harness.beforeStart(ctx, []);
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /invalid\.md.*name/);
	} finally {
		console.warn = original;
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));

test("extension harness invokes prompt events and delegate guards", withSandbox(async (project, agentDir) => {
	writeConfig(agentDir, { agentPresets: { fast: { model: "test-model", description: "Fast model" } } });
	const harness = createExtensionHarness();
	const { ctx } = fakeContext(project, [fakeModel()]);
	assert.equal(harness.tool.name, "delegate");
	assert.equal(harness.beforeStart(ctx, []), undefined);
	const output = harness.beforeStart(ctx, ["delegate"]);
	assert.match(output!.systemPrompt!, /base prompt/);
	assert.match(output!.systemPrompt!, /fast.*Fast model/);
	const bad = await harness.execute(ctx, { title: "title", input: "input", continue_session: "missing", agentPreset: "main" });
	assert.deepEqual(bad.details, { status: "failed", error: "Do not specify `agentPreset` or `skills` when continuing an existing child session." });
	assert.match(bad.content[0].type === "text" ? bad.content[0].text : "", /Do not specify/);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));
