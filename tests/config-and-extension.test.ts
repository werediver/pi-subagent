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

function writeAgent(agentDir: string, filename: string, content: string) {
	const dir = join(agentDir, "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, filename), content);
}

function failure(result: { details: unknown }): string {
	const details = result.details as { status: string; error: string };
	assert.equal(details.status, "failed");
	assert.equal(typeof details.error, "string");
	return details.error;
}

test("configuration parses model/base presets and descriptions", () => {
	assert.deepEqual(parseExtensionConfig({
		agentPresets: {
			parent: { description: "Parent" },
			fast: { model: " model ", provider: " provider ", thinkingLevel: "low" },
			derived: { base: " fast ", description: ["one", "two"] },
		},
	}, "test.json"), {
		agentPresets: {
			parent: { description: "Parent" },
			fast: { model: "model", provider: "provider", thinkingLevel: "low" },
			derived: { base: "fast", description: "one\ntwo" },
		},
	});
});

test("configuration rejects invalid preset fields", () => {
	for (const preset of [
		{ model: "m", base: "parent" }, { model: "" }, { base: "main", provider: "p" },
		{ model: "m", thinkingLevel: "very-high" }, { model: "m", unexpected: true },
	]) assert.throws(() => parseExtensionConfig({ agentPresets: { x: preset } }, "test.json"));
	assert.throws(() => parseExtensionConfig({ agentPresets: { parent: { model: "m" } } }, "test.json"));
});

test("configuration rejects every legacy preset tools value with migration guidance", () => {
	for (const tools of [{ "*": false }, {}, null, false, undefined]) {
		assert.throws(() => parseExtensionConfig({ agentPresets: { x: { model: "m", tools } } }, "test.json"), /preset "x".*test\.json.*move tools to an agent definition/i);
	}
	assert.throws(() => parseExtensionConfig({ agentPresets: { parent: { description: "parent", tools: {} } } }, "test.json"), /move tools to an agent definition/i);
	assert.throws(() => parseExtensionConfig({ agentPresets: { base: { model: "m", tools: { bash: false } }, child: { base: "base" } } }, "test.json"), /preset "base".*move tools to an agent definition/i);
});

test("configuration merges project over user only when trusted", withSandbox((project, agentDir) => {
	writeConfig(agentDir, { agentPresets: { shared: { model: "user" }, user: { base: "main" } } });
	writeConfig(join(project, CONFIG_DIR_NAME), { agentPresets: { shared: { model: "project" } } });
	const getConfig = (trusted: boolean) => loadExtensionConfig({ cwd: project, isProjectTrusted: () => trusted });
	assert.deepEqual(getConfig(true), { agentPresets: { shared: { model: "project" }, user: { base: "main" } } });
	assert.deepEqual(getConfig(false), { agentPresets: { shared: { model: "user" }, user: { base: "main" } } });
}));

test("legacy tools fail closed before merging overridden presets and respect project trust", withSandbox((project, agentDir) => {
	const projectDir = join(project, CONFIG_DIR_NAME);
	const getConfig = (trusted: boolean) => loadExtensionConfig({ cwd: project, isProjectTrusted: () => trusted });
	writeConfig(agentDir, { agentPresets: { shared: { model: "user", tools: { bash: false } } } });
	writeConfig(projectDir, { agentPresets: { shared: { model: "project" } } });
	assert.throws(() => getConfig(true), /preset "shared".*move tools to an agent definition/i);
	assert.throws(() => getConfig(false), /preset "shared".*move tools to an agent definition/i);
	writeConfig(agentDir, { agentPresets: { shared: { model: "user" } } });
	writeConfig(projectDir, { agentPresets: { shared: { base: "parent", tools: { bash: false } } } });
	assert.throws(() => getConfig(true), /preset "shared".*move tools to an agent definition/i);
	assert.deepEqual(getConfig(false), { agentPresets: { shared: { model: "user" } } });
}));

test("removed subagentPreamble is warned and ignored, including without UI", withSandbox((project, agentDir) => {
	writeConfig(agentDir, { subagentPreamble: null });
	writeConfig(join(project, CONFIG_DIR_NAME), { subagentPreamble: { invalid: true } });
	const { ctx, notifications } = fakeContext(project);
	assert.deepEqual(loadExtensionConfig(ctx), { agentPresets: {} });
	assert.equal(notifications.length, 2);
	for (const warning of notifications) {
		assert.equal(warning.level, "warning");
		assert.match(warning.message, /subagentPreamble.*removed.*ignored/i);
	}
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: unknown) => { warnings.push(String(message)); };
	try {
		Object.assign(ctx, { hasUI: false, isProjectTrusted: () => false });
		assert.deepEqual(loadExtensionConfig(ctx), { agentPresets: {} });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /subagentPreamble.*removed.*ignored/i);
	} finally { console.warn = original; }
}));

test("legacy preset tools prevent opening delegations even with a valid agent", withSandbox(async (project, agentDir) => {
	writeAgent(agentDir, "worker.md", "---\nname: worker\n---\nBody");
	writeConfig(agentDir, { agentPresets: { restricted: { model: "test-model", tools: { bash: false } } } });
	const { ctx, notifications } = fakeContext(project);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	harness.beforeStart(ctx, []);
	const result = await harness.execute(ctx, { title: "test", input: "test", agent: "worker" });
	assert.match(failure(result), /move tools to an agent definition/i);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /move tools to an agent definition/i);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));

test("root model context follows lifecycle events and stops on shutdown", withSandbox(async (project, agentDir) => {
	writeAgent(agentDir, "worker.md", "---\nname: worker\nmodel: unavailable\n---\nBody");
	const first = fakeModel("first", "root");
	const second = fakeModel("second", "root");
	const { ctx } = fakeContext(project, [first, second]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(harness.beforeStart(ctx, []), undefined);
	const request = { title: "test", input: "test", agent: "worker" };
	assert.match(failure(await harness.execute(ctx, request)), /first\/unavailable/);
	Object.assign(ctx, { model: second });
	await harness.emit("model_select", { type: "model_select", model: second, previousModel: first, source: "set" }, ctx);
	await harness.emit("thinking_level_select", { type: "thinking_level_select", level: "high", previousLevel: "low" }, ctx);
	assert.match(failure(await harness.execute(ctx, request)), /second\/unavailable/);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	assert.match(failure(await harness.execute(ctx, request)), /root session is unavailable/i);
}));

test("root snapshots definitions once, validates against full skills, and refreshes after shutdown", withSandbox(async (project, agentDir) => {
	const dir = join(agentDir, "agents");
	mkdirSync(dir);
	const definition = join(dir, "agent.md");
	writeFileSync(definition, "---\nname: first\nmodel: initial\nunknown: ignored\nskills: { preload: [hidden] }\n---\nBody");
	writeConfig(agentDir, { agentPresets: { initial: { model: "original-model" } } });
	const { ctx, notifications } = fakeContext(project);
	const hidden = { name: "hidden", disableModelInvocation: true } as Skill;
	const first = createExtensionHarness();
	await first.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	// Changes after session startup, but before the first turn, require reload.
	writeFileSync(definition, "---\nname: second\nskills: { preload: [missing] }\n---\n");
	writeConfig(agentDir, { agentPresets: { initial: { model: "changed-model" } } });
	// Validation completes after resource discovery even when delegate is inactive.
	assert.equal(first.beforeStart(ctx, [], "prompt", [hidden]), undefined);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /agent\.md.*unknown/);
	first.beforeStart(ctx, ["delegate"], "prompt", []);
	const request = { title: "test", input: "test" };
	assert.match(failure(await first.execute(ctx, { ...request, agent: "first" })), /original-model/);
	assert.match(failure(await first.execute(ctx, { ...request, agent: "second" })), /unknown agent/i);
	assert.equal(notifications.length, 1, "no rescanning or duplicate warnings");
	await first.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	const next = createExtensionHarness();
	next.beforeStart(ctx, [], "prompt", []);
	assert.match(failure(await next.execute(ctx, { ...request, agent: "first" })), /unknown agent/i);
	assert.match(failure(await next.execute(ctx, { ...request, agent: "second" })), /unknown agent/i);
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

test("opening requires a validated snapshot from the first turn", withSandbox(async (project, agentDir) => {
	writeAgent(agentDir, "worker.md", "---\nname: worker\n---\nBody");
	const harness = createExtensionHarness();
	const { ctx } = fakeContext(project);
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	const result = await harness.execute(ctx, { title: "test", input: "test", agent: "worker" });
	assert.match(failure(result), /snapshot|first turn|before.agent.start/i);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));

test("openings validate agent selectors and unknown continuation IDs fail immediately", withSandbox(async (project, agentDir) => {
	writeAgent(agentDir, "worker.md", "---\nname: worker\n---\nBody");
	const harness = createExtensionHarness();
	const { ctx } = fakeContext(project);
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(harness.tool.name, "delegate");
	const properties = harness.tool.parameters.properties as Record<string, unknown>;
	assert.ok("agent" in properties);
	assert.ok(!("agentPreset" in properties));
	assert.ok(!("skills" in properties));
	harness.beforeStart(ctx, []);
	const request = { title: "title", input: "input" };
	for (const agent of [undefined, "", "  "]) {
		assert.match(failure(await harness.execute(ctx, { ...request, agent })), /agent/i);
	}
	assert.match(failure(await harness.execute(ctx, { ...request, agent: "missing" })), /unknown agent/i);
	for (const agent of ["worker", "", "  "]) {
		const result = await harness.execute(ctx, { ...request, continue_session: "missing", agent });
		assert.match(failure(result), /session ID is unknown/i);
	}
	assert.match(failure(await harness.execute(ctx, { ...request, continue_session: "missing" })), /session ID is unknown/i);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));
