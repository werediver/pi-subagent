import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type Skill } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, fakeContext, fakeModel } from "./extension-harness.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

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

test("on-disk subagent.json files have no effect and produce no warnings", withSandbox(async (project, agentDir) => {
	writeAgent(agentDir, "worker.md", "---\nname: worker\nmodel: configured-name\n---\nBody");
	writeConfig(agentDir, { agentPresets: { "configured-name": { model: "global-target" } } });
	writeConfig(join(project, CONFIG_DIR_NAME), { agentPresets: { "configured-name": { model: "project-target" } } });
	const { ctx, notifications } = fakeContext(project, [
		fakeModel("root-provider", "root-model"),
		fakeModel("root-provider", "global-target"),
		fakeModel("root-provider", "project-target"),
	]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		harness.beforeStart(ctx, ["delegate"]);
		assert.match(failure(await harness.execute(ctx, { title: "test", input: "test", agent: "worker" })), /root-provider\/configured-name/);
		assert.equal(notifications.length, 0);
	} finally { await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx); }
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
	writeFileSync(definition, "---\nname: first\nmodel: original-model\nunknown: ignored\nskills: { preload: [hidden] }\n---\nBody");
	const { ctx, notifications } = fakeContext(project);
	const hidden = { name: "hidden", disableModelInvocation: true } as Skill;
	const first = createExtensionHarness();
	await first.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	// Changes after session startup, but before the first turn, require reload.
	writeFileSync(definition, "---\nname: second\nskills: { preload: [missing] }\n---\n");
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
