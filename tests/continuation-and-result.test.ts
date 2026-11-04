import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ContinuationQueue, type QueuedRequest } from "../src/queue.ts";
import { ChildRegistry, disposeChild, type ChildSession } from "../src/registry.ts";
import { createDelegateToolResult, formatDelegateResult, getAssistantText, getDelegateOutcome, resultError, type DelegateCmdResult } from "../src/result.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function session(abort: () => Promise<void> = async () => {}, dispose: () => void = () => {}, sessionId = "child"): AgentSession {
	return { abort, dispose, sessionId } as unknown as AgentSession;
}

function request(input: string, signal: AbortSignal = new AbortController().signal) {
	return { input, signal };
}

const completed = (text: string): DelegateCmdResult => ({ status: "completed", text });

test("initial request starts immediately and continuations run in order with their own results", async () => {
	const initial = deferred<DelegateCmdResult>();
	const first = deferred<DelegateCmdResult>();
	const firstStarted = deferred<void>();
	const secondStarted = deferred<void>();
	const batch = Symbol("turn");
	const calls: QueuedRequest[] = [];
	const queue = new ContinuationQueue(session(), async (req) => {
		calls.push(req);
		if (req.input === "initial") return initial.promise;
		if (req.input === "first") { firstStarted.resolve(undefined); return first.promise; }
		secondStarted.resolve(undefined);
		return completed(req.input);
	});
	const opening = queue.startInitial(request("initial"), batch);
	const continuation1 = queue.enqueue(request("first"), batch);
	const continuation2 = queue.enqueue(request("second"), batch);
	assert.deepEqual(calls.map(({ input }) => input), ["initial"]);
	initial.resolve(completed("opening result"));
	assert.deepEqual(await opening, completed("opening result"));
	await firstStarted.promise;
	assert.deepEqual(calls.map(({ input }) => input), ["initial", "first"]);
	first.resolve(completed("first result"));
	assert.deepEqual(await continuation1, completed("first result"));
	await secondStarted.promise;
	assert.deepEqual(await continuation2, completed("second"));
	assert.deepEqual(calls.map(({ input, batch: callBatch }) => [input, callBatch === batch]), [["initial", true], ["first", true], ["second", true]]);
});

test("different queues can run concurrently", async () => {
	const blocked = deferred<DelegateCmdResult>();
	const batch = Symbol("turn");
	const one = new ContinuationQueue(session(), () => blocked.promise);
	const two = new ContinuationQueue(session(), async (req) => completed(req.input));
	const pending = one.startInitial(request("blocked"), batch);
	assert.deepEqual(await two.enqueue(request("independent"), batch), completed("independent"));
	blocked.resolve(completed("done"));
	assert.deepEqual(await pending, completed("done"));
});

test("failure or cancellation breaks the queued batch, but a later batch can run", async (t) => {
	for (const mode of ["failed", "cancelled", "throw-error", "throw-value"] as const) {
		await t.test(mode, async () => {
			const gate = deferred<DelegateCmdResult>();
			const failedTurn = Symbol("failed-turn");
			const laterTurn = Symbol("later-turn");
			const calls: Array<[string, symbol]> = [];
			const queue = new ContinuationQueue(session(), async (req) => {
				calls.push([req.input, req.batch]);
				return req.input === "bad" ? gate.promise : completed(req.input);
			});
			const bad = queue.startInitial(request("bad"), failedTurn);
			const skipped1 = queue.enqueue(request("skipped1"), failedTurn);
			const skipped2 = queue.enqueue(request("skipped2"), failedTurn);
			if (mode === "throw-error") gate.reject(new Error("boom"));
			else if (mode === "throw-value") gate.reject("boom");
			else gate.resolve(resultError(mode, "boom"));
			assert.deepEqual(await bad, resultError(mode === "cancelled" ? "cancelled" : "failed", "boom"));
			const skipped = resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled.");
			assert.deepEqual(await skipped1, skipped);
			assert.deepEqual(await skipped2, skipped);
			assert.deepEqual(await queue.enqueue(request("later"), laterTurn), completed("later"));
			assert.deepEqual(calls, [["bad", failedTurn], ["later", laterTurn]]);
		});
	}
});

test("failure stays sticky after the queue empties until the turn changes", async () => {
	const failedTurn = Symbol("failed-turn");
	const laterTurn = Symbol("later-turn");
	const calls: string[] = [];
	const queue = new ContinuationQueue(session(), async (req) => {
		calls.push(req.input);
		return req.input === "bad" ? resultError("failed", "continuation failed") : completed(req.input);
	});
	assert.deepEqual(await queue.enqueue(request("bad"), failedTurn), resultError("failed", "continuation failed"));
	assert.deepEqual(await queue.enqueue(request("same turn"), failedTurn), resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled."));
	assert.deepEqual(await queue.enqueue(request("later turn"), laterTurn), completed("later turn"));
	assert.deepEqual(calls, ["bad", "later turn"]);
});

test("a failed continuation skips later continuations but preserves the queue for reuse", async () => {
	const gate = deferred<DelegateCmdResult>();
	const started = deferred<void>();
	const batch = Symbol("failed-turn");
	const laterBatch = Symbol("later-turn");
	const calls: string[] = [];
	const queue = new ContinuationQueue(session(), async (req) => {
		calls.push(req.input);
		if (req.input === "bad") { started.resolve(undefined); return gate.promise; }
		return completed(req.input);
	});
	assert.deepEqual(await queue.startInitial(request("initial"), Symbol("opening-turn")), completed("initial"));
	const bad = queue.enqueue(request("bad"), batch);
	const skipped = queue.enqueue(request("skipped"), batch);
	await started.promise;
	gate.resolve(resultError("failed", "continuation failed"));
	assert.deepEqual(await bad, resultError("failed", "continuation failed"));
	assert.deepEqual(await skipped, resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled."));
	assert.deepEqual(await queue.enqueue(request("reuse"), laterBatch), completed("reuse"));
	assert.deepEqual(calls, ["initial", "bad", "reuse"]);
});

test("a continuation aborted while waiting does not run and breaks its batch", async () => {
	const gate = deferred<DelegateCmdResult>();
	const batch = Symbol("turn");
	const laterBatch = Symbol("later-turn");
	const calls: string[] = [];
	const queue = new ContinuationQueue(session(), async (req) => {
		calls.push(req.input);
		return req.input === "initial" ? gate.promise : completed(req.input);
	});
	const initial = queue.startInitial(request("initial"), batch);
	const controller = new AbortController();
	const cancelled = queue.enqueue(request("cancelled", controller.signal), batch);
	const skipped = queue.enqueue(request("skipped"), batch);
	controller.abort();
	gate.resolve(completed("initial"));
	assert.deepEqual(await initial, completed("initial"));
	assert.deepEqual(await cancelled, resultError("cancelled", "Continuation was cancelled while waiting."));
	assert.deepEqual(await skipped, resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled."));
	assert.deepEqual(await queue.enqueue(request("later"), laterBatch), completed("later"));
	assert.deepEqual(calls, ["initial", "later"]);
});

test("a rejected active request is classified as cancelled if its signal was aborted", async () => {
	const gate = deferred<DelegateCmdResult>();
	const controller = new AbortController();
	const queue = new ContinuationQueue(session(), () => gate.promise);
	const active = queue.startInitial(request("active", controller.signal), Symbol("turn"));
	controller.abort();
	gate.reject(new Error("abort failed"));
	assert.deepEqual(await active, resultError("cancelled", "abort failed"));
});

test("close aborts once, rejects queued and future work, and waits for abort and active work", async () => {
	const activeGate = deferred<DelegateCmdResult>();
	const abortGate = deferred<void>();
	let aborts = 0;
	const calls: string[] = [];
	const queue = new ContinuationQueue(session(() => { aborts++; return abortGate.promise; }), async (req) => {
		calls.push(req.input);
		return activeGate.promise;
	});
	const batch = Symbol("turn");
	const active = queue.startInitial(request("active"), batch);
	const waiting = queue.enqueue(request("waiting"), batch);
	let closed = false;
	const closing = queue.close().then(() => { closed = true; });
	const closingAgain = queue.close();
	assert.equal(aborts, 1);
	assert.equal(closed, false);
	abortGate.reject(new Error("abort error is ignored"));
	// Give close's rejection handler and tail wait time to run without timers.
	for (let i = 0; i < 5; i++) await Promise.resolve();
	assert.equal(closed, false);
	activeGate.resolve(completed("finished"));
	assert.deepEqual(await active, completed("finished"));
	assert.deepEqual(await waiting, resultError("cancelled", "Child session was closed."));
	await Promise.all([closing, closingAgain]);
	assert.equal(closed, true);
	assert.deepEqual(calls, ["active"]);
	assert.deepEqual(await queue.startInitial(request("after close"), Symbol("after-close")), resultError("cancelled", "Child session was closed."));
	assert.deepEqual(await queue.enqueue(request("afterwards"), Symbol("after-close")), resultError("cancelled", "Child session was closed."));
});

test("close also waits for abort after active and queued requests settle", async () => {
	const activeGate = deferred<DelegateCmdResult>();
	const abortGate = deferred<void>();
	const queue = new ContinuationQueue(session(() => abortGate.promise), () => activeGate.promise);
	const batch = Symbol("turn");
	const active = queue.startInitial(request("active"), batch);
	const waiting = queue.enqueue(request("waiting"), batch);
	let closed = false;
	const closing = queue.close().then(() => { closed = true; });
	activeGate.resolve(completed("done"));
	assert.deepEqual(await active, completed("done"));
	assert.deepEqual(await waiting, resultError("cancelled", "Child session was closed."));
	assert.equal(closed, false);
	abortGate.resolve(undefined);
	await closing;
	assert.equal(closed, true);
});

test("result envelope escapes content, omits inappropriate fields, and sets error metadata", () => {
	const success: DelegateCmdResult = { status: "completed", sessionId: `id<&\"'`, text: "<hello> & \"world\" 'x'\u0001", error: "ignored" };
	const xml = "<delegate_result>\n  <status>completed</status>\n  <session_id>id&lt;&amp;&quot;&apos;</session_id>\n  <text>&lt;hello&gt; &amp; &quot;world&quot; &apos;x&apos;</text>\n</delegate_result>";
	assert.equal(formatDelegateResult(success), xml);
	assert.deepEqual(createDelegateToolResult(success), { content: [{ type: "text", text: xml }], details: success });
	assert.equal(formatDelegateResult({ status: "completed", sessionId: "", text: "" }), "<delegate_result>\n  <status>completed</status>\n  <text></text>\n</delegate_result>");
	for (const status of ["failed", "cancelled"] as const) {
		const failure: DelegateCmdResult = { status, sessionId: "secret", text: "hidden", error: "<bad> & 'worse'" };
		const failureXml = `<delegate_result>\n  <status>${status}</status>\n  <error>&lt;bad&gt; &amp; &apos;worse&apos;</error>\n</delegate_result>`;
		assert.deepEqual(createDelegateToolResult(failure), { content: [{ type: "text", text: failureXml }], details: failure, isError: true });
		assert.match(formatDelegateResult({ status }), /<error>Delegation failed\.<\/error>/);
	}
});

test("outcome uses the last assistant message, maps stop reasons and extracts text parts", () => {
	assert.equal(getAssistantText(null), "");
	assert.equal(getAssistantText({ content: "not an array" }), "");
	assert.equal(getAssistantText({ content: [null, { type: "thinking", thinking: "hidden" }, { type: "text", text: "one" }, { type: "text", text: 1 }, { type: "text", text: "two" }] }), "one\n\ntwo");
	const messages = [
		{ role: "assistant", stopReason: "error", errorMessage: "old error" },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] },
		{ role: "toolResult", content: [{ type: "text", text: "not assistant" }] },
	];
	assert.deepEqual(getDelegateOutcome(messages, false), completed("one\n\ntwo"));
	assert.deepEqual(getDelegateOutcome(messages, true), resultError("cancelled", "Delegation was cancelled."));
	assert.deepEqual(getDelegateOutcome([], false), { status: "completed" });
	assert.deepEqual(getDelegateOutcome([{ role: "assistant", content: [] }], false), { status: "completed" });
	assert.deepEqual(getDelegateOutcome([{ role: "assistant", stopReason: "error", errorMessage: "provider error" }], false), resultError("failed", "provider error"));
	assert.deepEqual(getDelegateOutcome([{ role: "assistant", stopReason: "error" }], false), resultError("failed", "Delegation failed."));
	assert.deepEqual(getDelegateOutcome([{ role: "assistant", stopReason: "aborted", errorMessage: "stopped" }], false), resultError("cancelled", "stopped"));
	assert.deepEqual(getDelegateOutcome([{ role: "assistant", stopReason: "aborted" }], false), resultError("cancelled", "Delegation was cancelled."));
	assert.deepEqual(getDelegateOutcome([{ role: "assistant", stopReason: "error", errorMessage: "interrupted" }], true), resultError("cancelled", "interrupted"));
});

function child(id: string, events: string[], abort: () => Promise<void> = async () => {}): ChildSession {
	const childSession = session(async () => { events.push(`abort:${id}`); await abort(); }, () => { events.push(`dispose:${id}`); }, id);
	return { session: childSession, cwd: "/", queue: new ContinuationQueue(childSession, async () => completed("unused")), nestedRegistry: new ChildRegistry() };
}

test("registry removal is identity-safe and shutdown disposes nested children before parents once", async () => {
	const events: string[] = [];
	const registry = new ChildRegistry();
	const old = child("parent", events);
	const parent = child("parent", events);
	const nested = child("nested", events);
	parent.nestedRegistry.add(nested);
	registry.add(old);
	registry.add(parent);
	registry.remove("parent", old);
	assert.equal(registry.get("parent"), parent);
	await Promise.all([registry.close(), registry.close(), disposeChild(parent)]);
	assert.equal(registry.isClosed(), true);
	assert.equal(registry.get("parent"), undefined);
	assert.deepEqual(events, ["abort:nested", "dispose:nested", "abort:parent", "dispose:parent"]);
	assert.throws(() => registry.add(old), /shutting down/);
	await disposeChild(parent);
	assert.equal(events.length, 4);
});

test("cleanup continues through a failing descendant shutdown", async () => {
	const events: string[] = [];
	const registry = new ChildRegistry();
	const parent = child("parent", events);
	const nested = child("nested", events);
	nested.shutdown = async () => { events.push("shutdown:nested"); throw new Error("shutdown failed"); };
	parent.shutdown = async () => { events.push("shutdown:parent"); };
	parent.nestedRegistry.add(nested);
	registry.add(parent);
	await assert.rejects(registry.close(), /Could not close all child sessions/);
	assert.deepEqual(events, ["abort:nested", "shutdown:nested", "dispose:nested", "abort:parent", "shutdown:parent", "dispose:parent"]);
	assert.equal(registry.get("parent"), undefined);
});

test("registry shutdown waits for tracked setups even when they reject", async () => {
	const registry = new ChildRegistry();
	const setup = deferred<void>();
	const tracked = registry.trackSetup(setup.promise);
	const rejected = assert.rejects(tracked, /setup failed/);
	let closed = false;
	const closing = registry.close().then(() => { closed = true; });
	assert.equal(registry.isClosed(), true);
	await Promise.resolve();
	assert.equal(closed, false);
	setup.reject(new Error("setup failed"));
	await rejected;
	await closing;
	assert.equal(closed, true);
});
