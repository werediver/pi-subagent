import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ContinuationQueue } from "../src/queue.ts";
import { runChildRequest } from "../src/runner.ts";
import type { ChildSession } from "../src/registry.ts";

const GATE_KEY = "pi-extension-active-cancellation-test";

type GateState = {
	preflightStarted(): void;
	release: Promise<void>;
	modelRequest(): void;
	toolExecuted(): void;
};

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function gateState() {
	const started = deferred<void>();
	const release = deferred<void>();
	let modelRequests = 0;
	let toolExecutions = 0;
	const state: GateState = {
		preflightStarted: () => started.resolve(),
		release: release.promise,
		modelRequest: () => { modelRequests++; },
		toolExecuted: () => { toolExecutions++; },
	};
	(globalThis as any)[Symbol.for(GATE_KEY)] = state;
	return {
		started: started.promise,
		release: () => release.resolve(),
		modelRequests: () => modelRequests,
		toolExecutions: () => toolExecutions,
	};
}

async function createGatedSession(cwd: string, agentDir: string) {
	const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	const typeboxPath = fileURLToPath(import.meta.resolve("typebox"));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "gated-provider.js"), `
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
import { Type } from ${JSON.stringify(typeboxPath)};
const gate = globalThis[Symbol.for(${JSON.stringify(GATE_KEY)})];
export default function (pi) {
  pi.registerProvider("cancel-test", {
    baseUrl: "https://invalid.example", apiKey: "test-key", api: "cancel-test-api",
    models: [{ id: "cancel-model", name: "Cancellation test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
    streamSimple(model, context) {
      gate.modelRequest();
      const stream = createAssistantMessageEventStream();
      const user = context.messages.filter(message => message.role === "user").at(-1);
      const prompt = typeof user?.content === "string" ? user.content : (user?.content || []).map(part => part.text || "").join("");
      const hasToolCall = !["seed session", "resume after cancellation"].includes(prompt);
      const call = { type: "toolCall", id: "probe-call", name: "cancellation_probe", arguments: {} };
      const text = "Answer: " + prompt;
      const message = { role: "assistant", content: hasToolCall ? [call] : [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: hasToolCall ? "toolUse" : "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      if (hasToolCall) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      } else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
  pi.registerTool({
    name: "cancellation_probe", label: "Cancellation probe", description: "Records unexpected tool execution",
    parameters: Type.Object({}),
    async execute() { gate.toolExecuted(); return { content: [{ type: "text", text: "executed" }] }; },
  });
  pi.on("before_agent_start", async (event) => {
    if (["cancel during preflight", "close during preflight", "cancel active continuation"].includes(event.prompt)) {
      gate.preflightStarted();
      await gate.release;
    }
  });
}
`);
	const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "always", retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const model: Model<Api> = {
		provider: "cancel-test", id: "cancel-model", name: "Cancellation test", api: "cancel-test-api",
		baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
	};
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, model, sessionManager: SessionManager.inMemory(cwd) });
	await session.bindExtensions({ mode: "print" });
	return session;
}

async function withFixture(run: (gate: ReturnType<typeof gateState>, session: Awaited<ReturnType<typeof createGatedSession>>, cwd: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-active-cancellation-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const gate = gateState();
	let session: Awaited<ReturnType<typeof createGatedSession>> | undefined;
	try {
		session = await createGatedSession(cwd, agentDir);
		await run(gate, session, cwd);
	} finally {
		gate.release();
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
			session.dispose();
		}
		delete (globalThis as any)[Symbol.for(GATE_KEY)];
		rmSync(root, { recursive: true, force: true });
	}
}

function request(input: string, signal: AbortSignal) {
	return { input, signal };
}

test("real AgentSession caller cancellation during before_agent_start prevents request and tool work", () => withFixture(async (gate, session, cwd) => {
	const child = { session, cwd } as unknown as ChildSession;
	const queue = new ContinuationQueue((req) => runChildRequest(child, req.input, req.signal, undefined, undefined, cwd), session);
	const controller = new AbortController();
	const batch = Symbol("caller-cancellation");
	let activeSettled = false;
	const active = queue.startInitial(request("cancel during preflight", controller.signal), batch).then((result) => {
		activeSettled = true;
		return result;
	});
	const waiting = queue.enqueue(request("must be skipped", new AbortController().signal), batch);
	await gate.started;
	controller.abort();
	await Promise.resolve();
	assert.equal(activeSettled, false, "prompt and queue remain occupied while preflight is gated");
	assert.equal(gate.modelRequests(), 0);
	assert.equal(gate.toolExecutions(), 0);

	gate.release();
	assert.equal((await active).status, "cancelled");
	assert.deepEqual(await waiting, { status: "failed", error: "Continuation skipped because the previous continuation failed or was cancelled." });
	assert.equal(gate.modelRequests(), 0, "cancelled prompt did not reach the provider");
	assert.equal(gate.toolExecutions(), 0, "cancelled prompt did not execute the provider's tool call");
	await queue.close();
}));

test("real AgentSession can continue in a new batch after active continuation cancellation settles", () => withFixture(async (gate, session, cwd) => {
	const child = { session, cwd } as unknown as ChildSession;
	const queue = new ContinuationQueue((req) => runChildRequest(child, req.input, req.signal, undefined, undefined, cwd), session);
	const seedBatch = Symbol("seed");
	const seed = await queue.startInitial(request("seed session", new AbortController().signal), seedBatch);
	assert.deepEqual(seed, { status: "completed", text: "Answer: seed session" });
	assert.equal(gate.modelRequests(), 1);
	assert.equal(gate.toolExecutions(), 0);

	const cancelledBatch = Symbol("cancelled-continuation");
	const controller = new AbortController();
	let activeSettled = false;
	const active = queue.enqueue(request("cancel active continuation", controller.signal), cancelledBatch).then((result) => {
		activeSettled = true;
		return result;
	});
	await gate.started;
	controller.abort();
	await Promise.resolve();
	assert.equal(activeSettled, false, "the active continuation remains in preflight until released");
	assert.equal(gate.modelRequests(), 1, "canceled continuation has not made a model request");
	assert.equal(gate.toolExecutions(), 0, "canceled continuation has not executed a tool");

	gate.release();
	assert.equal((await active).status, "cancelled");
	assert.equal(gate.modelRequests(), 1, "canceled continuation never reached the provider");
	assert.equal(gate.toolExecutions(), 0, "canceled continuation never executed a tool call");
	assert.equal(session.isIdle, true, "abort cleanup settled the AgentSession before returning");

	const resumed = await queue.enqueue(request("resume after cancellation", new AbortController().signal), Symbol("resume-after-cancellation"));
	assert.deepEqual(resumed, { status: "completed", text: "Answer: resume after cancellation" });
	assert.equal(session.isIdle, true, "the resumed continuation also leaves the session idle");
	assert.equal(gate.modelRequests(), 2, "only the seed and resumed continuation reached the provider");
	assert.equal(gate.toolExecutions(), 0, "neither successful prompt required the probe tool");
	await queue.close();
}));

test("real AgentSession queue close during before_agent_start prevents request and waits for settlement", () => withFixture(async (gate, session, cwd) => {
	const child = { session, cwd } as unknown as ChildSession;
	const queue = new ContinuationQueue((req) => runChildRequest(child, req.input, req.signal, undefined, undefined, cwd), session);
	const batch = Symbol("shutdown-cancellation");
	let activeSettled = false, closeSettled = false;
	const active = queue.startInitial(request("close during preflight", new AbortController().signal), batch).then((result) => {
		activeSettled = true;
		return result;
	});
	const waiting = queue.enqueue(request("must not start", new AbortController().signal), batch);
	await gate.started;
	const closing = queue.close().then(() => { closeSettled = true; });
	const closingAgain = queue.close();
	await Promise.resolve();
	assert.equal(activeSettled, false, "queue close waits for the gated prompt");
	assert.equal(closeSettled, false);
	assert.equal(gate.modelRequests(), 0);
	assert.equal(gate.toolExecutions(), 0);

	gate.release();
	assert.equal((await active).status, "cancelled");
	assert.deepEqual(await waiting, { status: "cancelled", error: "Child session was closed." });
	await Promise.all([closing, closingAgain]);
	assert.equal(closeSettled, true);
	assert.deepEqual(await queue.enqueue(request("future work", new AbortController().signal), Symbol("future")), { status: "cancelled", error: "Child session was closed." });
	assert.equal(gate.modelRequests(), 0, "shutdown-cancelled prompt did not reach the provider");
	assert.equal(gate.toolExecutions(), 0, "shutdown-cancelled prompt did not execute the provider's tool call");
}));
