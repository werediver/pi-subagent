import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

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
