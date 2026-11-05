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
	const request = { title: "Test", input: "Test", agent: "worker" };
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	try {
		// Sources were captured at startup: changing the file cannot remove the agent.
		writeFileSync(file, "---\nname: replacement\n---\nChanged");
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;: Worker description');
		assert.ok(notifications.some(({ message }) => /rejected\.md.*tools/i.test(message)));

		// No intervening beforeStart or model_select: execution must resolve again.
		Object.assign(ctx, { model: rootB });
		const unavailable = failure(await harness.execute(ctx, request));
		assert.match(unavailable, /provider-b\/shared-id/);
		assert.doesNotMatch(unavailable, /unknown agent/i);
		assert.equal(options(prompt(harness, ctx)), "", "no agent is currently available");
		assert.match(failure(await harness.execute(ctx, request)), /provider-b\/shared-id/);
		for (const agent of ["missing", "rejected", "replacement"]) {
			assert.match(failure(await harness.execute(ctx, { ...request, agent })), /unknown agent/i);
		}

		Object.assign(ctx, { model: rootA });
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;: Worker description', "known agent reappears without reload");
		// Again bypass beforeStart; absence of a root model fails resolution before
		// any attempt to create a child session with the fake provider.
		Object.assign(ctx, { model: undefined });
		const noRoot = failure(await harness.execute(ctx, request));
		assert.match(noRoot, /needs a provider.*root session has no active model/i);
		assert.doesNotMatch(noRoot, /unknown agent/i);
		assert.equal(options(prompt(harness, ctx)), "");
		Object.assign(ctx, { model: rootA });
		assert.equal(options(prompt(harness, ctx)), '- &quot;worker&quot;: Worker description');
	} finally {
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
