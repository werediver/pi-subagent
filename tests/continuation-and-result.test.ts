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
	const queue = new ContinuationQueue(async (req) => {
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
	const one = new ContinuationQueue(() => blocked.promise);
	const two = new ContinuationQueue(async (req) => completed(req.input));
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
			const queue = new ContinuationQueue(async (req) => {
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
	const queue = new ContinuationQueue(async (req) => {
		calls.push(req.input);
		return req.input === "bad" ? resultError("failed", "continuation failed") : completed(req.input);
	});
	assert.deepEqual(await queue.enqueue(request("bad"), failedTurn), resultError("failed", "continuation failed"));
	assert.deepEqual(await queue.enqueue(request("same turn"), failedTurn), resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled."));
	assert.deepEqual(await queue.enqueue(request("later turn"), laterTurn), completed("later turn"));
	assert.deepEqual(calls, ["bad", "later turn"]);
});

test("an ordered failure marker sticks to its batch and later batches can reuse the queue", async () => {
	const initialGate = deferred<DelegateCmdResult>();
	const batch = Symbol("invalid-turn");
	const laterBatch = Symbol("later-turn");
	const calls: string[] = [];
	const queue = new ContinuationQueue(async (req) => {
		calls.push(req.input);
		return req.input === "initial" ? initialGate.promise : completed(req.input);
	});
	const initial = queue.startInitial(request("initial"), batch);
	const invalid = resultError("failed", "invalid continuation");
	let markerSettled = false;
	const failureMarker = queue.enqueueFailure(invalid, new AbortController().signal, batch).then((result) => {
		markerSettled = true;
		return result;
	});
	const following = queue.enqueue(request("following"), batch);
	await Promise.resolve();
	assert.equal(markerSettled, false);
	assert.deepEqual(calls, ["initial"]);

	initialGate.resolve(completed("initial result"));
	assert.deepEqual(await initial, completed("initial result"));
	assert.deepEqual(await failureMarker, invalid);
	const skipped = resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled.");
	assert.deepEqual(await following, skipped);
	assert.deepEqual(await queue.enqueue(request("same batch after drain"), batch), skipped);
	assert.deepEqual(await queue.enqueue(request("later batch"), laterBatch), completed("later batch"));
	assert.deepEqual(calls, ["initial", "later batch"]);
});

test("a failure marker is skipped when an earlier same-batch request failed", async () => {
	const batch = Symbol("failed-turn");
	const laterBatch = Symbol("later-turn");
	const queue = new ContinuationQueue(async (req) => req.input === "bad"
		? resultError("failed", "earlier failure")
		: completed(req.input));
	assert.deepEqual(await queue.enqueue(request("bad"), batch), resultError("failed", "earlier failure"));
	assert.deepEqual(await queue.enqueueFailure(resultError("failed", "invalid continuation"), new AbortController().signal, batch), resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled."));
	assert.deepEqual(await queue.enqueue(request("later"), laterBatch), completed("later"));
});

test("failure markers honor abort and close", async () => {
	const queue = new ContinuationQueue(async (req) => completed(req.input));
	const controller = new AbortController();
	controller.abort();
	const batch = Symbol("aborted-turn");
	assert.deepEqual(await queue.enqueueFailure(resultError("failed", "invalid continuation"), controller.signal, batch), resultError("cancelled", "Continuation was cancelled while waiting."));
	assert.deepEqual(await queue.enqueue(request("same turn"), batch), resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled."));
	await queue.close();
	assert.deepEqual(await queue.enqueueFailure(resultError("failed", "invalid continuation"), new AbortController().signal, Symbol("closed-turn")), resultError("cancelled", "Child session was closed."));
});

test("a failed continuation skips later continuations but preserves the queue for reuse", async () => {
	const gate = deferred<DelegateCmdResult>();
	const started = deferred<void>();
	const batch = Symbol("failed-turn");
	const laterBatch = Symbol("later-turn");
	const calls: string[] = [];
	const queue = new ContinuationQueue(async (req) => {
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
	const queue = new ContinuationQueue(async (req) => {
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

test("caller cancellation aborts only the active operation scope and classifies rejection", async () => {
	const gate = deferred<DelegateCmdResult>();
	const controller = new AbortController();
	let scopedSignal: AbortSignal | undefined;
	const queue = new ContinuationQueue((req) => { scopedSignal = req.signal; return gate.promise; });
	const active = queue.startInitial(request("active", controller.signal), Symbol("turn"));
	assert.ok(scopedSignal);
	assert.notEqual(scopedSignal, controller.signal);
	controller.abort();
	assert.equal(scopedSignal.aborted, true);
	gate.reject(new Error("abort failed"));
	assert.deepEqual(await active, resultError("cancelled", "abort failed"));
});

test("close aborts the active scope, rejects queued and future work, and waits for active cleanup", async () => {
	const activeGate = deferred<DelegateCmdResult>();
	const cleanupStarted = deferred<void>();
	const cleanupGate = deferred<void>();
	const calls: string[] = [];
	let activeSignal: AbortSignal | undefined;
	const queue = new ContinuationQueue((req) => {
		calls.push(req.input);
		activeSignal = req.signal;
		req.signal.addEventListener("abort", () => cleanupStarted.resolve(undefined), { once: true });
		return activeGate.promise.then(async (result) => { await cleanupGate.promise; return result; });
	});
	const batch = Symbol("turn");
	const active = queue.startInitial(request("active"), batch);
	const waiting = queue.enqueue(request("waiting"), batch);
	let closed = false;
	const closing = queue.close().then(() => { closed = true; });
	const closingAgain = queue.close();
	assert.equal(activeSignal?.aborted, true);
	await cleanupStarted.promise;
	assert.equal(closed, false);
	activeGate.resolve(completed("finished"));
	await Promise.resolve();
	assert.equal(closed, false, "close still waits for active prompt cleanup");
	cleanupGate.resolve(undefined);
	assert.deepEqual(await active, completed("finished"));
	assert.deepEqual(await waiting, resultError("cancelled", "Child session was closed."));
	await Promise.all([closing, closingAgain]);
	assert.equal(closed, true);
	assert.deepEqual(calls, ["active"]);
	assert.deepEqual(await queue.startInitial(request("after close"), Symbol("after-close")), resultError("cancelled", "Child session was closed."));
	assert.deepEqual(await queue.enqueue(request("afterwards"), Symbol("after-close")), resultError("cancelled", "Child session was closed."));
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
	return { session: childSession, cwd: "/", queue: new ContinuationQueue(async () => completed("unused"), childSession), nestedRegistry: new ChildRegistry() };
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
	assert.deepEqual(events, ["abort:parent", "abort:nested", "dispose:nested", "dispose:parent"]);
	assert.throws(() => registry.add(old), /shutting down/);
	await disposeChild(parent);
	assert.equal(events.length, 4);
});

test("parent abort starts promptly while descendant shutdown blocks final disposal", async () => {
	const events: string[] = [];
	const parentAborted = deferred<void>();
	const nestedShutdownStarted = deferred<void>();
	const releaseNestedShutdown = deferred<void>();
	const parent = child("parent", events, async () => { parentAborted.resolve(undefined); });
	const nested = child("nested", events);
	parent.shutdown = async () => { events.push("shutdown:parent"); };
	nested.shutdown = async () => {
		events.push("shutdown:nested");
		nestedShutdownStarted.resolve(undefined);
		await releaseNestedShutdown.promise;
	};
	parent.nestedRegistry.add(nested);

	const disposing = disposeChild(parent);
	await parentAborted.promise;
	await nestedShutdownStarted.promise;
	assert.deepEqual(await parent.queue.enqueue(request("late work"), Symbol("shutdown-turn")), resultError("cancelled", "Child session was closed."));
	assert.deepEqual(events, ["abort:parent", "abort:nested", "shutdown:nested"]);
	releaseNestedShutdown.resolve(undefined);
	await disposing;
	assert.deepEqual(events, ["abort:parent", "abort:nested", "shutdown:nested", "dispose:nested", "shutdown:parent", "dispose:parent"]);
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
	assert.deepEqual(events, ["abort:parent", "abort:nested", "shutdown:nested", "dispose:nested", "shutdown:parent", "dispose:parent"]);
	assert.equal(registry.get("parent"), undefined);
});

test("registry shutdown waits for an opening's failure cleanup", async () => {
	const registry = new ChildRegistry();
	const setup = deferred<void>();
	const cleanup = deferred<void>();
	const openingStarted = deferred<void>();
	const cleanupStarted = deferred<void>();
	let cleanupFinished = false;
	const opening = registry.trackOpening(async () => {
		openingStarted.resolve(undefined);
		try {
			await setup.promise;
			throw new Error("setup failed");
		} catch (error) {
			cleanupStarted.resolve(undefined);
			await cleanup.promise;
			cleanupFinished = true;
			throw error;
		}
	});
	const openingRejected = assert.rejects(opening, /setup failed/);
	await openingStarted.promise;
	let closed = false;
	const closing = registry.close();
	const closingRejected = assert.rejects(closing, /Could not close all child sessions/).finally(() => { closed = true; });
	assert.equal(registry.isClosed(), true);
	setup.resolve(undefined);
	await cleanupStarted.promise;
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(cleanupFinished, false);
	cleanup.resolve(undefined);
	await Promise.all([openingRejected, closingRejected]);
	assert.equal(closed, true);
	assert.equal(cleanupFinished, true);
	let invokedAfterClose = false;
	await assert.rejects(registry.trackOpening(async () => { invokedAfterClose = true; }), /shutting down/);
	assert.equal(invokedAfterClose, false);
});

test("registry close aborts and disposes a child while its opening operation settles", async () => {
	const events: string[] = [];
	const registry = new ChildRegistry();
	const registered = deferred<void>();
	const active = deferred<DelegateCmdResult>();
	const childSession = session(async () => {
		events.push("abort:opening");
		active.resolve(resultError("cancelled", "closed"));
	}, () => { events.push("dispose:opening"); }, "opening");
	const child: ChildSession = {
		session: childSession, cwd: "/",
		queue: new ContinuationQueue((request) => {
			request.signal.addEventListener("abort", () => { void childSession.abort(); }, { once: true });
			return active.promise;
		}, childSession),
		nestedRegistry: new ChildRegistry(),
		shutdown: async () => { events.push("shutdown:opening"); },
	};
	const opening = registry.trackOpening(async () => {
		registry.add(child);
		registered.resolve(undefined);
		const result = await child.queue.startInitial(request("initial"), Symbol("opening-turn"));
		if (result.status !== "completed") {
			registry.remove(child.session.sessionId, child);
			await disposeChild(child);
		}
		return result;
	});
	await registered.promise;
	const closing = registry.close();
	const [result] = await Promise.all([opening, closing]);
	assert.deepEqual(result, resultError("cancelled", "closed"));
	assert.deepEqual(events, ["abort:opening", "shutdown:opening", "dispose:opening"]);
});
