import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, fakeContext, fakeModel } from "./extension-harness.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

function withSandbox(run: (project: string, agentDir: string) => Promise<void>) {
	return async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-digest-"));
		const project = join(root, "project");
		const agentDir = join(root, "user-agent");
		mkdirSync(join(project, CONFIG_DIR_NAME, "agents"), { recursive: true });
		mkdirSync(join(agentDir, "agents"), { recursive: true });
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

function failure(result: { details: unknown }): string {
	const details = result.details as { status: string; error: string };
	assert.equal(details.status, "failed");
	assert.equal(typeof details.error, "string");
	return details.error;
}

function prompt(harness: ReturnType<typeof createExtensionHarness>, ctx: ReturnType<typeof fakeContext>["ctx"]): string {
	const result = harness.beforeStart(ctx, ["delegate"], "BASE PROMPT");
	assert.ok(result);
	assert.equal(typeof result.systemPrompt, "string");
	return result.systemPrompt!;
}

function options(systemPrompt: string): string {
	const match = systemPrompt.match(/<delegate_agent_options>\n([\s\S]*?)\n<\/delegate_agent_options>/);
	assert.ok(match, "expected an agent digest");
	return match[1];
}

test("live provider changes update the digest and openings without rebuilding the snapshot", withSandbox(async (project, agentDir) => {
	const file = join(agentDir, "agents", "worker.md");
	writeFileSync(file, "---\nname: worker\ndescription: Worker description\nmodel: shared-id\n---\nPRIVATE WORKER BODY");
	writeFileSync(join(agentDir, "agents", "rejected.md"), "---\nname: rejected\ntools: invalid\n---\nPRIVATE REJECTED BODY");
	const rootA = fakeModel("provider-a", "root-a");
	const rootB = fakeModel("provider-b", "root-b");
	const targetA = fakeModel("provider-a", "shared-id");
	const { ctx, notifications } = fakeContext(project, [rootA, rootB, targetA]);
	const harness = createExtensionHarness();
	const request = { title: "Test", input: "Test", new_agent: "worker" };
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		// Sources were captured at startup: changing the file cannot remove the agent.
		writeFileSync(file, "---\nname: replacement\n---\nChanged");
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;: Worker description');
		assert.ok(notifications.some(({ message }) => /rejected\.md.*tools/i.test(message)));

		// No intervening beforeStart or model_select: execution must resolve again.
		Object.assign(ctx, { model: rootB });
		const unavailable = failure(await harness.execute(ctx, request));
		assert.match(unavailable, /"provider-b"\/"shared-id"/);
		assert.doesNotMatch(unavailable, /unknown agent/i);
		assert.equal(options(prompt(harness, ctx)), "", "no agent is currently available");
		assert.match(failure(await harness.execute(ctx, request)), /"provider-b"\/"shared-id"/);
		for (const newAgent of ["missing", "rejected", "replacement"]) {
			assert.match(failure(await harness.execute(ctx, { ...request, new_agent: newAgent })), /unknown agent/i);
		}

		Object.assign(ctx, { model: rootA });
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;: Worker description', "known agent reappears without reload");
		// Again bypass beforeStart; absence of a root model fails resolution before
		// any attempt to create a child session with the fake provider.
		Object.assign(ctx, { model: undefined });
		const noRoot = failure(await harness.execute(ctx, request));
		assert.match(noRoot, /no root provider.*shared-id/i);
		assert.doesNotMatch(noRoot, /unknown agent/i);
		assert.equal(options(prompt(harness, ctx)), "");
		Object.assign(ctx, { model: rootA });
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;: Worker description');
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));

test("unconfigured exact candidates warn through preflight, digest, and opening, then recover with warning dedupe", withSandbox(async (project, agentDir) => {
	const filename = join(agentDir, "agents", "worker.md");
	writeFileSync(filename, "---\nname: worker\nmodel:\n  - { id: first-model, provider: first-provider }\n  - { id: later-model, provider: later-provider }\n---\nWorker body");
	const root = fakeModel("root-provider", "root");
	const first = fakeModel("first-provider", "first-model");
	const later = fakeModel("later-provider", "later-model");
	const { ctx, notifications, authStatuses } = fakeContext(project, [root, first, later]);
	authStatuses.set("first-provider", false);
	authStatuses.set("later-provider", false);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		assert.equal(notifications.length, 1, "startup preflight warns for registered model with missing provider auth");
		assert.ok(notifications[0].message.includes(filename));
		assert.match(notifications[0].message, /agent "worker"/);
		assert.match(notifications[0].message, /registered, but provider auth is not configured/);
		assert.ok(notifications[0].message.includes("/login first-provider"));
		assert.match(notifications[0].message, /pi auth check --provider first-provider/);
		assert.doesNotMatch(notifications[0].message, /secret|api.?key|token/i);
		assert.equal(options(prompt(harness, ctx)), "", "agent with unconfigured auth is omitted from digest");
		const openingError = failure(await harness.execute(ctx, { title: "Test", input: "Test", new_agent: "worker" }));
		assert.match(openingError, /registered, but provider auth is not configured/);
		assert.match(openingError, /first-provider/);
		assert.doesNotMatch(openingError, /later-provider/, "the diagnostic identifies the first unconfigured exact match");
		assert.equal(notifications.length, 1, "the opening error does not duplicate the root warning");

		authStatuses.set("first-provider", true);
		authStatuses.set("later-provider", true);
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;', "agent becomes available when auth is configured");
		assert.equal(notifications.length, 1, "observed recovery clears warning state without notifying");
		authStatuses.set("first-provider", false);
		authStatuses.set("later-provider", false);
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 2, "a new unavailable period warns again");
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 2, "auth warnings deduplicate while continuously unavailable");
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));

test("a ready later candidate keeps the agent available without an auth warning", withSandbox(async (project, agentDir) => {
	writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\nmodel:\n  - { id: first-model, provider: first-provider, thinkingLevel: low }\n  - { id: later-model, provider: later-provider, thinkingLevel: xhigh }\n---\nWorker body");
	const { ctx, notifications, authStatuses } = fakeContext(project, [
		fakeModel("root-provider", "root"),
		fakeModel("first-provider", "first-model"),
		fakeModel("later-provider", "later-model"),
	]);
	authStatuses.set("first-provider", false);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		assert.equal(notifications.length, 0, "an unconfigured earlier candidate does not warn when a later candidate resolves");
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;');
		assert.equal(notifications.length, 0, "live digest checks also remain warning-free");
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));

test("root warns once per unresolved model period even when delegate is inactive", withSandbox(async (project, agentDir) => {
	const filename = join(agentDir, "agents", "worker.md");
	writeFileSync(filename, "---\nname: worker\nmodel: target-id\n---\nWorker body");
	writeFileSync(join(agentDir, "agents", "inherited.md"), "---\nname: inherited\n---\nInherited body");
	const rootB = fakeModel("provider-b", "root-b");
	const rootA = fakeModel("provider-a", "root-a");
	const targetA = fakeModel("provider-a", "target-id");
	const { ctx, notifications } = fakeContext(project, [rootB, rootA, targetA]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		assert.equal(notifications.length, 1, "startup preflight warns before any prompt");
		assert.ok(notifications[0].message.includes(filename));
		assert.equal(harness.beforeStart(ctx, []), undefined, "model checks run while delegate is inactive");
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "warning");
		assert.ok(notifications[0].message.includes(filename));
		assert.match(notifications[0].message, /agent "worker"/);
		assert.match(notifications[0].message, /"provider-b"\/"target-id"/);
		assert.match(notifications[0].message, /register a matching model.*update the agent's model candidates/i);
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 1, "repeat checks during the unavailable period are deduplicated");

		Object.assign(ctx, { model: rootA });
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 1, "observed availability clears the warning state without notifying");
		Object.assign(ctx, { model: rootB });
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 2, "a later unavailable period warns again");

		const error = failure(await harness.execute(ctx, { title: "Test", input: "Test", new_agent: "worker" }));
		assert.match(error, /"provider-b"\/"target-id"/);
		assert.equal(notifications.length, 2, "manual opening retains its resolution error without warning again");
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));

test("unresolved model warnings use console.warn without UI and skip inherited agents", withSandbox(async (project, agentDir) => {
	const filename = join(agentDir, "agents", "worker.md");
	writeFileSync(filename, "---\nname: worker\nmodel: { id: target-id, provider: explicit-provider }\n---\nWorker body");
	writeFileSync(join(agentDir, "agents", "inherited.md"), "---\nname: inherited\n---\nInherited body");
	const { ctx, notifications, authStatuses } = fakeContext(project, [fakeModel("root-provider", "root"), fakeModel("explicit-provider", "target-id")]);
	authStatuses.set("explicit-provider", false);
	Object.assign(ctx, { hasUI: false, model: undefined });
	const harness = createExtensionHarness();
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message: unknown) => { warnings.push(String(message)); };
	try {
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		assert.equal(warnings.length, 1, "startup preflight logs without UI");
		harness.beforeStart(ctx, []);
		harness.beforeStart(ctx, []);
		assert.equal(notifications.length, 0);
		assert.equal(warnings.length, 1, "only the explicit-model agent warns, once");
		assert.ok(warnings[0].includes(filename));
		assert.match(warnings[0], /agent "worker"/);
		assert.match(warnings[0], /"explicit-provider"\/"target-id"/);
		assert.match(warnings[0], /registered, but provider auth is not configured/);
		assert.ok(warnings[0].includes("/login explicit-provider"));
		assert.match(warnings[0], /pi auth check --provider explicit-provider/);
	} finally {
		console.warn = originalWarn;
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));

test("active delegate gets only escaped agent names and descriptions; inactive delegate gets no digest", withSandbox(async (project, agentDir) => {
	const projectFile = join(project, CONFIG_DIR_NAME, "agents", "project-secret-path.md");
	const userFile = join(agentDir, "agents", "user-secret-path.md");
	writeFileSync(projectFile, `---\nname: 'name<&>"'\ndescription: 'Purpose <tag> & "quotes" and ''apostrophe'''\nmodel: target-id\n---\nPROJECT_PRIVATE_BODY`);
	writeFileSync(userFile, "---\nname: plain\n---\nUSER_PRIVATE_BODY");
	const { ctx } = fakeContext(project, [fakeModel("provider-a", "root"), fakeModel("provider-a", "target-id")]);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		assert.equal(harness.beforeStart(ctx, [], "BASE PROMPT"), undefined);
		assert.equal(harness.beforeStart(ctx, ["read", "bash"], "BASE PROMPT"), undefined);
		const result = prompt(harness, ctx);
		assert.ok(result.startsWith("BASE PROMPT\n\n"));
		assert.equal(options(result), [
			'- &quot;name&lt;&amp;&gt;\\&quot;&quot;: Purpose &lt;tag&gt; &amp; &quot;quotes&quot; and &apos;apostrophe&apos;',
			'- &quot;plain&quot;',
		].join("\n"));
		for (const secret of ["PROJECT_PRIVATE_BODY", "USER_PRIVATE_BODY", projectFile, userFile, "project-secret-path", "user-secret-path", "target-id", "agentPreset"]) {
			assert.ok(!result.includes(secret), `digest leaked ${secret}`);
		}
		assert.doesNotMatch(result, /\b(project|user|scope)\b/i);
		assert.equal(harness.beforeStart(ctx, ["read"], "BASE PROMPT"), undefined);
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
	}
}));
