import type { AgentSession, AgentToolUpdateCallback, Theme } from "@earendil-works/pi-coding-agent";
import type { DelegateCmdResult } from "./result.ts";
import { resultError } from "./result.ts";

export type QueuedRequest = {
	task: string;
	signal: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	theme?: Theme;
	batch: number;
};

export class ContinuationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private nextBatch = 0;
	private broken: { result: DelegateCmdResult; batch: number } | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(private readonly session: AgentSession, private readonly run: (request: QueuedRequest) => Promise<DelegateCmdResult>) {}

	private schedule(request: QueuedRequest, initial: boolean): Promise<DelegateCmdResult> {
		const previous = this.tail;
		const batch = request.batch;
		this.pending++;
		const operation = (async () => {
			if (!initial) await previous;
			if (this.closed || request.signal.aborted) return resultError("cancelled", this.closed ? "Child session was closed." : "Continuation was cancelled while waiting.");
			if (!initial && this.broken?.batch === batch) return resultError("failed", "Continuation skipped because the previous continuation failed or was cancelled.");
			return this.run(request);
		})();
		const result = operation
			.catch((error) => resultError(request.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)))
			.then((value) => {
				if (value.status !== "completed" && this.broken?.batch !== batch) {
					this.broken = { result: value, batch };
					this.nextBatch++;
				}
				return value;
			})
			.finally(() => { this.pending--; if (!this.pending) this.broken = undefined; });
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	startInitial(request: Omit<QueuedRequest, "batch">): Promise<DelegateCmdResult> {
		return this.schedule({ ...request, batch: this.nextBatch }, true);
	}

	enqueue(request: Omit<QueuedRequest, "batch">): Promise<DelegateCmdResult> {
		return this.schedule({ ...request, batch: this.nextBatch }, false);
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => { await this.session.abort().catch(() => { }); await this.tail; })();
		return this.closing;
	}
}
