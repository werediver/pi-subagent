import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, fakeContext } from "./extension-harness.ts";
import type { DelegateCmdResult } from "../src/result.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const GATE_KEY = "pi-subagent-opening-cancellation-test";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function writeAgent(agentDir: string) {
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\n---\nWorker\n");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "opening-gate.js"), `
const key = Symbol.for(${JSON.stringify(GATE_KEY)});
export default function (pi) {
  const gate = globalThis[key];
  gate.factoryCalled();
  pi.on("session_start", async (_event, ctx) => {
    gate.sessionId(ctx.sessionManager.getSessionId());
    gate.started();
    await gate.release;
  });
  pi.on("agent_start", () => gate.promptStarted());
  pi.on("session_shutdown", () => gate.stopped());
}
`);
}

async function withFixture(run: (project: string, agentDir: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-opening-cancellation-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeAgent(agentDir);
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try { await run(project, agentDir); }
	finally {
		delete (globalThis as any)[Symbol.for(GATE_KEY)];
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}

function gateState() {
	const started = deferred();
	const stopped = deferred();
	const release = deferred();
	let factoryCalls = 0;
	let startCalls = 0;
	let stopCalls = 0;
	let promptCalls = 0;
	let childSessionId: string | undefined;
	const state = {
		factoryCalled: () => { factoryCalls++; },
		sessionId: (id: string) => { childSessionId = id; },
		started: () => { startCalls++; started.resolve(); },
		promptStarted: () => { promptCalls++; },
		stopped: () => { stopCalls++; stopped.resolve(); },
		release: release.promise,
	};
	(globalThis as any)[Symbol.for(GATE_KEY)] = state;
	return {
		started: started.promise, stopped: stopped.promise,
		release: () => release.resolve(),
		factoryCalls: () => factoryCalls, startCalls: () => startCalls, promptCalls: () => promptCalls, stopCalls: () => stopCalls,
		childSessionId: () => childSessionId,
	};
}

function details(result: { details: unknown }): DelegateCmdResult {
	return result.details as DelegateCmdResult;
}

async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("caller cancellation was not prompt")), 500); }),
		]);
	} finally { if (timeout) clearTimeout(timeout); }
}

test("pre-aborted opening does not start setup", () => withFixture(async (project) => {
	const gate = gateState();
	const { ctx } = fakeContext(project);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	harness.beforeStart(ctx, []);
	const controller = new AbortController();
	controller.abort();
	const result = details(await harness.execute(ctx, { title: "Cancelled", input: "must not run", new_agent: "worker" }, controller.signal));
	assert.equal(result.status, "cancelled");
	assert.equal(gate.factoryCalls(), 0, "resource-loader extension factory was not loaded");
	assert.equal(gate.startCalls(), 0);
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));

test("setup cancellation returns promptly while tracked opening cleanup remains part of shutdown", () => withFixture(async (project) => {
	const gate = gateState();
	const { ctx } = fakeContext(project);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	harness.beforeStart(ctx, []);
	const controller = new AbortController();
	const executing = harness.execute(ctx, { title: "Cancelled while binding", input: "must not run", new_agent: "worker" }, controller.signal);
	await gate.started;
	controller.abort();
	const result = details(await promptly(executing));
	assert.equal(result.status, "cancelled");
	assert.equal(result.sessionId, undefined, "cancelled setup never exposes a child ID");
	assert.equal(gate.stopCalls(), 0, "the lifecycle is still waiting for bindExtensions to settle");

	let shutdownFinished = false;
	const shutdown = harness.emit("session_shutdown", { type: "session_shutdown" }, ctx).then(() => { shutdownFinished = true; });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(shutdownFinished, false, "registry shutdown awaits the tracked opening");
	assert.equal(gate.stopCalls(), 0, "the in-flight setup stage has not been forcibly interrupted");

	gate.release();
	await shutdown;
	assert.equal(shutdownFinished, true);
	assert.equal(gate.stopCalls(), 1, "the created session was shut down during awaited cleanup");
	assert.equal(gate.promptCalls(), 0, "initial prompting did not run after setup cancellation");
}));

test("a cancelled setup does not retain its child session ID", () => withFixture(async (project) => {
	const gate = gateState();
	const { ctx } = fakeContext(project);
	const harness = createExtensionHarness();
	await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	harness.beforeStart(ctx, []);
	const controller = new AbortController();
	const executing = harness.execute(ctx, { title: "Cancelled setup", input: "must not run", new_agent: "worker" }, controller.signal);
	await gate.started;
	controller.abort();
	assert.equal(details(await promptly(executing)).status, "cancelled");
	gate.release();
	await gate.stopped;
	const childSessionId = gate.childSessionId();
	assert.ok(childSessionId, "the partial child session was created");
	const lookup = details(await harness.execute(ctx, { title: "Check retained ID", input: "must not run", continue_session: childSessionId }));
	assert.equal(lookup.status, "failed");
	assert.match(lookup.error ?? "", /unknown, expired, or cwd-mismatched/i);
	assert.equal(gate.promptCalls(), 0, "initial prompting did not run after setup cancellation");
	await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
}));
