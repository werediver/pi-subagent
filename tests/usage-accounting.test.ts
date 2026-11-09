import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ContinuationQueue } from "../src/queue.ts";
import { createDelegateToolResult, type DelegateCmdResult } from "../src/result.ts";
import { runChildRequest } from "../src/runner.ts";
import type { ChildSession } from "../src/registry.ts";
import { aggregateUsageEntries, type ReportedUsage } from "../src/usage.ts";

function usage(input: number, output = 0, cacheRead = 0, cacheWrite = 0, cost = input + output + cacheRead + cacheWrite): ReportedUsage {
	return {
		input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantEntry(value: ReportedUsage, stopReason = "stop") {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: value, stopReason } };
}

function toolResultEntry(value: ReportedUsage) {
	return { type: "message", message: { role: "toolResult", usage: value } };
}

function appendAssistant(state: FakeSession, value: ReportedUsage, stopReason = "stop") {
	const message = { role: "assistant", content: [{ type: "text", text: "answer" }], usage: value, stopReason };
	state.entries.push({ type: "message", message });
	state.messages.push(message);
}

type FakeSession = {
	entries: unknown[];
	messages: any[];
	session: AgentSession;
};

function fakeSession(prompt: (input: string, state: FakeSession) => Promise<void> | void): FakeSession {
	const state = { entries: [] as unknown[], messages: [] as any[], session: undefined as unknown as AgentSession };
	state.session = {
		messages: state.messages,
		sessionManager: { getEntries: () => [...state.entries] },
		subscribe: () => () => {},
		prompt: (input: string) => prompt(input, state),
		abort: async () => {},
	} as unknown as AgentSession;
	return state;
}

function childFor(state: FakeSession): ChildSession {
	return { session: state.session, cwd: "/", nestedRegistry: undefined, queue: undefined } as unknown as ChildSession;
}

function signalRequest(input: string, signal = new AbortController().signal) {
	return { input, signal };
}

test("aggregates assistant, tool-result, and request summary usage, counting nested delegation once", () => {
	const entries = [
		assistantEntry(usage(2, 3, 4, 5)),
		// Pi persists nested delegation's reported usage on this tool-result entry.
		// It is already included here; the collector does not traverse descendants.
		toolResultEntry(usage(7, 11, 13, 17)),
		{ type: "compaction", usage: usage(1, 2) },
		{ type: "branch_summary", usage: usage(0, 1) },
		{ type: "message", message: { role: "user", usage: usage(100) } },
		{ type: "usage", usage: usage(1000) }, // asynchronous/cache-warm usage is unassignable
	];
	assert.deepEqual(aggregateUsageEntries(entries), {
		input: 10, output: 17, cacheRead: 17, cacheWrite: 22, totalTokens: 66,
		cost: { input: 66, output: 0, cacheRead: 0, cacheWrite: 0, total: 66 },
	});

	const providerReported = usage(1);
	providerReported.cacheWrite1h = 2;
	providerReported.reasoning = 3;
	providerReported.cost.totalFromProvider = true;
	const providerSummary = usage(0, 1);
	providerSummary.cost.totalFromProvider = true;
	assert.deepEqual(aggregateUsageEntries([assistantEntry(providerReported), { type: "compaction", usage: providerSummary }]), {
		input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 2, reasoning: 3, totalTokens: 2,
		cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2, totalFromProvider: true },
	});
});

test("serialized continuations report only usage appended by each invocation", async () => {
	const state = fakeSession((_input, current) => {
		appendAssistant(current, _input === "first" ? usage(2, 3) : usage(5, 7));
		current.entries.push({ type: "usage", usage: usage(500) });
	});
	const child = childFor(state);
	const queue = new ContinuationQueue((request) => runChildRequest(child, request.input, request.signal, undefined, undefined, "/"), state.session);
	const batch = Symbol("continuations");
	const first = await queue.startInitial(signalRequest("first"), batch);
	const second = await queue.enqueue(signalRequest("second"), batch);

	assert.deepEqual(first.usage, usage(2, 3));
	assert.deepEqual(second.usage, usage(5, 7));
	assert.equal(second.status, "completed");
	const hostResult = createDelegateToolResult(second);
	assert.deepEqual(hostResult.usage, usage(5, 7));
	assert.doesNotMatch(hostResult.content[0].text, /usage/i, "the model-facing XML contract is unchanged");
	await queue.close();
});

test("a continuation aborted before its serialized run accrues no usage", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const state = fakeSession(async (_input, current) => {
		await gate;
		appendAssistant(current, usage(2, 1));
	});
	const child = childFor(state);
	const queue = new ContinuationQueue((request) => runChildRequest(child, request.input, request.signal, undefined, undefined, "/"), state.session);
	const batch = Symbol("pre-execution-cancellation");
	const active = queue.startInitial(signalRequest("active"), batch);
	const controller = new AbortController();
	controller.abort();
	const skipped = queue.enqueue(signalRequest("skipped", controller.signal), batch);
	release();
	assert.deepEqual((await active).usage, usage(2, 1));
	const skippedResult = await skipped;
	assert.equal(skippedResult.status, "cancelled");
	assert.equal(skippedResult.usage, undefined);
	await queue.close();
});

test("known partial usage is carried on request errors", async () => {
	const state = fakeSession((_input, current) => {
		appendAssistant(current, usage(3, 4), "error");
		throw new Error("provider failed after partial response");
	});
	const result = await runChildRequest(childFor(state), "fail", new AbortController().signal, undefined, undefined, "/");
	assert.deepEqual(result, {
		status: "failed", error: "provider failed after partial response", usage: usage(3, 4),
	});
	assert.deepEqual(createDelegateToolResult(result).usage, usage(3, 4));
});

test("cancellation waits for abort cleanup and includes settled partial usage, but excludes background usage", async () => {
	let markPromptStarted!: () => void;
	const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
	let finishPrompt!: () => void;
	const promptFinished = new Promise<void>((resolve) => { finishPrompt = resolve; });
	let releaseAbortCleanup!: () => void;
	const abortCleanupGate = new Promise<void>((resolve) => { releaseAbortCleanup = resolve; });
	const state = fakeSession(async (_input, current) => {
		appendAssistant(current, usage(4, 6), "aborted");
		current.entries.push({ type: "usage", usage: usage(900) });
		markPromptStarted();
		await promptFinished;
	});
	state.session.abort = async () => {
		await abortCleanupGate;
		state.entries.push({ type: "compaction", usage: usage(2, 1) });
		finishPrompt();
	};
	const controller = new AbortController();
	let settled = false;
	const running = runChildRequest(childFor(state), "cancel", controller.signal, undefined, undefined, "/").then((result) => {
		settled = true;
		return result;
	});
	await promptStarted;
	controller.abort();
	await Promise.resolve();
	assert.equal(settled, false, "the request remains active until abort-owned cleanup settles");
	releaseAbortCleanup();
	const result = await running;
	assert.equal(result.status, "cancelled");
	assert.deepEqual(result.usage, usage(6, 7));
	assert.deepEqual(createDelegateToolResult(result).usage, usage(6, 7));
});

test("missing usage and standalone background usage produce no reported Usage", async () => {
	const state = fakeSession((_input, current) => {
		current.entries.push({ type: "usage", usage: usage(1234) });
	});
	const result: DelegateCmdResult = await runChildRequest(childFor(state), "no usage", new AbortController().signal, undefined, undefined, "/");
	assert.equal(result.status, "completed");
	assert.equal(result.usage, undefined);
	assert.equal(createDelegateToolResult(result).usage, undefined);
});

test("independent parallel child queues account only their own session entries", async () => {
	let arrivals = 0;
	let release!: () => void;
	const bothStarted = new Promise<void>((resolve) => { release = resolve; });
	const makeParallelChild = (value: ReportedUsage) => {
		const state = fakeSession(async (_input, current) => {
			arrivals++;
			if (arrivals === 2) release();
			await bothStarted;
			appendAssistant(current, value);
		});
		const child = childFor(state);
		const queue = new ContinuationQueue((request) => runChildRequest(child, request.input, request.signal, undefined, undefined, "/"), state.session);
		return { state, queue };
	};
	const one = makeParallelChild(usage(2, 1));
	const two = makeParallelChild(usage(8, 3));
	const [first, second] = await Promise.all([
		one.queue.startInitial(signalRequest("one"), Symbol("one")),
		two.queue.startInitial(signalRequest("two"), Symbol("two")),
	]);
	assert.deepEqual(first.usage, usage(2, 1));
	assert.deepEqual(second.usage, usage(8, 3));
	await Promise.all([one.queue.close(), two.queue.close()]);
});
