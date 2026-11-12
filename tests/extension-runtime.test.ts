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

test("on-disk subagent.json files have no effect and unresolved models are warned", withSandbox(async (project, agentDir) => {
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
		assert.match(failure(await harness.execute(ctx, { title: "test", input: "test", new_agent: "worker" })), /"root-provider"\/"configured-name"/);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /worker\.md.*agent "worker"/);
		assert.match(notifications[0].message, /"root-provider"\/"configured-name"/);
	} finally { await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx); }
}));

test("session_start preflight reports structural and model issues but defers missing skills", withSandbox(async (project, agentDir) => {
	const malformed = join(agentDir, "agents", "malformed.md");
	const worker = join(agentDir, "agents", "worker.md");
	writeAgent(agentDir, "malformed.md", "---\nname: malformed\nmystery: true\nmodel: { id: [not-a-string] }\n---\nBody");
	writeAgent(agentDir, "worker.md", "---\nname: worker\nmodel: unavailable-id\n---\nBody");
	writeAgent(agentDir, "skill.md", "---\nname: skill-user\nmodel: skill-model\nskills: { preload: [not-loaded] }\n---\nBody");
	const { ctx, notifications } = fakeContext(project, [fakeModel("root-provider", "root")]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		assert.equal(notifications.length, 4);
		assert.ok(notifications.some(({ message }) => message.includes(malformed) && /unknown frontmatter field.*mystery/.test(message)));
		assert.ok(notifications.some(({ message }) => message.includes(malformed) && /model\.id.*non-empty string/.test(message)));
		const modelWarning = notifications.find(({ message }) => message.includes(worker));
		assert.ok(modelWarning);
		assert.equal(modelWarning.level, "warning");
		assert.match(modelWarning.message, /agent "worker"/);
		assert.match(modelWarning.message, /"root-provider"\/"unavailable-id"/);
		assert.ok(!notifications.some(({ message }) => message.includes("not-loaded")), "skill names cannot be checked before discovery");
		const skillModelWarning = notifications.find(({ message }) => message.includes("skill.md"));
		assert.ok(skillModelWarning);
		assert.match(skillModelWarning.message, /agent "skill-user"/);
		assert.match(skillModelWarning.message, /"root-provider"\/"skill-model"/);

		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 5);
		assert.ok(notifications.some(({ message }) => message.includes("skill.md") && /unknown preloaded skill.*not-loaded/.test(message)));
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 5, "preflight warnings and deferred diagnostics are not repeated");
	} finally { await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx); }
}));

test("project preload failure does not claim a duplicate name or model warning before final precedence", withSandbox(async (project, agentDir) => {
	const projectAgents = join(project, CONFIG_DIR_NAME, "agents");
	mkdirSync(projectAgents, { recursive: true });
	const projectFile = join(projectAgents, "shared.md");
	const userFile = join(agentDir, "agents", "shared.md");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(projectFile, "---\nname: shared\nmodel: project-model\nskills: { preload: [not-loaded] }\n---\nProject");
	writeFileSync(userFile, "---\nname: shared\nmodel: user-model\n---\nUser");
	const { ctx, notifications } = fakeContext(project, [fakeModel("root-provider", "root")]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		assert.equal(notifications.length, 0, "winner and model warning are uncertain until preload validation");
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 2);
		assert.ok(notifications.some(({ message }) => message.includes(projectFile) && /unknown preloaded skill.*not-loaded/.test(message)));
		const modelWarning = notifications.find(({ message }) => message.includes(userFile));
		assert.ok(modelWarning);
		assert.match(modelWarning.message, /agent "shared"/);
		assert.match(modelWarning.message, /"root-provider"\/"user-model"/);
		assert.ok(!notifications.some(({ message }) => message.includes(projectFile) && /None of the model candidates/.test(message)));
		assert.ok(!notifications.some(({ message }) => /duplicate agent name "shared"/.test(message)));
		const error = failure(await harness.execute(ctx, { title: "test", input: "test", new_agent: "shared" }));
		assert.match(error, /"root-provider"\/"user-model"/);
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
	const request = { title: "test", input: "test", new_agent: "worker" };
	assert.match(failure(await harness.execute(ctx, request)), /"first"\/"unavailable"/);
	Object.assign(ctx, { model: second });
	await harness.emit("model_select", { type: "model_select", model: second, previousModel: first, source: "set" }, ctx);
	await harness.emit("thinking_level_select", { type: "thinking_level_select", level: "high", previousLevel: "low" }, ctx);
	assert.match(failure(await harness.execute(ctx, request)), /"second"\/"unavailable"/);
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
	assert.equal(notifications.length, 2, "structural and independent model diagnostics are reported during startup preflight");
	assert.match(notifications[0].message, /agent\.md.*unknown frontmatter field/);
	assert.match(notifications[1].message, /agent\.md.*agent "first".*original-model/);
	assert.doesNotMatch(notifications.join("\n"), /old-missing/);
	// Changes after session startup, but before the first turn, require reload.
	writeFileSync(definition, "---\nname: second\nskills: { preload: [missing] }\n---\n");
	// Validation completes after resource discovery even when delegate is inactive.
	assert.equal(first.beforeStart(ctx, [], "prompt", [hidden]), undefined);
	assert.equal(notifications.length, 2, "preflight model warnings are not repeated after the catalog validates");
	first.beforeStart(ctx, ["delegate"], "prompt", []);
	const request = { title: "test", input: "test" };
	assert.match(failure(await first.execute(ctx, { ...request, new_agent: "first" })), /original-model/);
	assert.match(failure(await first.execute(ctx, { ...request, new_agent: "second" })), /unknown agent/i);
	assert.equal(notifications.length, 2, "no rescanning or duplicate warnings");
	await first.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	const next = createExtensionHarness();
	await next.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(notifications.length, 2, "missing skill names are deferred until the full catalog is available");
	next.beforeStart(ctx, [], "prompt", []);
	next.beforeStart(ctx, [], "prompt", []);
	assert.match(failure(await next.execute(ctx, { ...request, new_agent: "first" })), /unknown agent/i);
	assert.match(failure(await next.execute(ctx, { ...request, new_agent: "second" })), /unknown agent/i);
	assert.equal(notifications.length, 3);
	assert.match(notifications[2].message, /agent\.md.*unknown preloaded skill.*missing/);
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
	const result = await harness.execute(ctx, { title: "test", input: "test", new_agent: "worker" });
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
	assert.ok("new_agent" in properties);
	assert.ok(!("agent" in properties));
	assert.ok(!("agentPreset" in properties));
	assert.ok(!("skills" in properties));
	harness.beforeStart(ctx, []);
	const request = { title: "title", input: "input" };
	for (const newAgent of [undefined, "", "  "]) {
		assert.match(failure(await harness.execute(ctx, { ...request, new_agent: newAgent })), /new_agent/i);
	}
	assert.match(failure(await harness.execute(ctx, { ...request, new_agent: "missing" })), /unknown agent/i);
	for (const newAgent of ["worker", "", "  "]) {
		const result = await harness.execute(ctx, { ...request, continue_session: "missing", new_agent: newAgent });
		assert.match(failure(result), /session ID is unknown/i);
	}
	assert.match(failure(await harness.execute(ctx, { ...request, continue_session: "missing" })), /session ID is unknown/i);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));
