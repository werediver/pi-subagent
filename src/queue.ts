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

	constructor(private readonly session: AgentSession, private readonly run: (request: QueuedRequest) => Promise<DelegateCmdResult>) {}

	private schedule(batch: symbol, signal: AbortSignal, initial: boolean, run: () => Promise<DelegateCmdResult> | DelegateCmdResult): Promise<DelegateCmdResult> {
		const previous = this.tail;
		const operation = (async () => {
			if (!initial) await previous;
			if (this.closed || signal.aborted) return resultError("cancelled", this.closed ? "Child session was closed." : "Continuation was cancelled while waiting.");
			if (!initial && this.failedBatch === batch) return resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled.");
			return run();
		})();
		const result = operation
			.catch((error) => resultError(signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)))
			.then((value) => {
				if (value.status !== "completed") this.failedBatch = batch;
				return value;
			});
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	startInitial(request: Omit<QueuedRequest, "batch">, batch: symbol): Promise<DelegateCmdResult> {
		const queued = { ...request, batch };
		return this.schedule(batch, queued.signal, true, () => this.run(queued));
	}

	enqueue(request: Omit<QueuedRequest, "batch">, batch: symbol): Promise<DelegateCmdResult> {
		const queued = { ...request, batch };
		return this.schedule(batch, queued.signal, false, () => this.run(queued));
	}

	enqueueFailure(failure: DelegateCmdResult, signal: AbortSignal, batch: symbol): Promise<DelegateCmdResult> {
		return this.schedule(batch, signal, false, () => failure);
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => { await this.session.abort().catch(() => { }); await this.tail; })();
		return this.closing;
	}
}
