import type { AgentSession, AgentToolUpdateCallback, Theme } from "@earendil-works/pi-coding-agent";
import type { DelegateCmdResult } from "./result.ts";
import { resultError } from "./result.ts";

export type QueuedRequest = {
	input: string;
	signal: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	theme?: Theme;
	batch: symbol;
};

export class ContinuationQueue {
	private tail: Promise<void> = Promise.resolve();
	// Sticky across an idle queue; only a distinct caller turn starts a new batch.
	private failedBatch: symbol | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	private activeScope: AbortController | undefined;

	constructor(private readonly run: (request: QueuedRequest) => Promise<DelegateCmdResult>, private readonly session?: AgentSession) {}

	private schedule(batch: symbol, signal: AbortSignal, initial: boolean, run: (signal: AbortSignal) => Promise<DelegateCmdResult> | DelegateCmdResult): Promise<DelegateCmdResult> {
		const previous = this.tail;
		let operationSignal: AbortSignal | undefined;
		const operation = (async () => {
			if (!initial) await previous;
			if (this.closed || signal.aborted) return resultError("cancelled", this.closed ? "Child session was closed." : "Continuation was cancelled while waiting.");
			if (!initial && this.failedBatch === batch) return resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled.");

			const scope = new AbortController();
			const abortScope = () => scope.abort();
			operationSignal = scope.signal;
			this.activeScope = scope;
			signal.addEventListener("abort", abortScope, { once: true });
			// No async boundary occurs between the earlier check and listener setup,
			// but re-check for an already-aborted signal for completeness.
			if (signal.aborted || this.closed) abortScope();
			try {
				return await run(scope.signal);
			} finally {
				signal.removeEventListener("abort", abortScope);
				if (this.activeScope === scope) this.activeScope = undefined;
			}
		})();
		const result = operation
			.catch((error) => resultError(signal.aborted || operationSignal?.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)))
			.then((value) => {
				if (value.status !== "completed") this.failedBatch = batch;
				return value;
			});
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	startInitial(request: Omit<QueuedRequest, "batch">, batch: symbol): Promise<DelegateCmdResult> {
		const queued = { ...request, batch };
		return this.schedule(batch, queued.signal, true, (signal) => this.run({ ...queued, signal }));
	}

	enqueue(request: Omit<QueuedRequest, "batch">, batch: symbol): Promise<DelegateCmdResult> {
		const queued = { ...request, batch };
		return this.schedule(batch, queued.signal, false, (signal) => this.run({ ...queued, signal }));
	}

	enqueueFailure(failure: DelegateCmdResult, signal: AbortSignal, batch: symbol): Promise<DelegateCmdResult> {
		return this.schedule(batch, signal, false, () => failure);
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		const activeScope = this.activeScope;
		activeScope?.abort();
		this.closing = (async () => {
			// An active run owns abort cleanup through its combined signal. Preserve
			// idle-session shutdown without racing it against that same cleanup.
			if (!activeScope) await this.session?.abort().catch(() => { });
			await this.tail;
		})();
		return this.closing;
	}
}
