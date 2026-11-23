import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ContinuationQueue } from "./queue.ts";

export type ChildSession = {
	// Extension-owned handle in `<agent_name>:<per-agent index>` form (e.g. "scout:1").
	// Distinct from Pi's AgentSession.sessionId (a UUIDv7), which is never exposed.
	id: string;
	agentName: string;
	session: AgentSession;
	cwd: string;
	queue: ContinuationQueue;
	nestedRegistry: ChildRegistry;
	shutdown?: () => Promise<void>;
	cleanup?: Promise<void>;
};

export class ChildRegistry {
	private readonly children = new Map<string, ChildSession>();
	private readonly counters = new Map<string, number>();
	private readonly openings = new Set<Promise<unknown>>();
	private closed = false;
	private closing: Promise<void> | undefined;

	isClosed(): boolean { return this.closed; }
	get(id: string): ChildSession | undefined { return this.children.get(id); }
	/** Allocate the next handle for an agent in this registry, e.g. "scout:1", "scout:2". Monotonic per agent within this registry's lifetime; never reused, even after removal. */
	allocateId(agentName: string): string {
		if (this.closed) throw new Error("The extension runtime is shutting down.");
		const next = (this.counters.get(agentName) ?? 0) + 1;
		this.counters.set(agentName, next);
		return `${agentName}:${next}`;
	}
	add(child: ChildSession): void {
		if (this.closed) throw new Error("The extension runtime is shutting down.");
		this.children.set(child.id, child);
	}
	remove(id: string, child: ChildSession): void {
		if (this.children.get(id) === child) this.children.delete(id);
	}
	trackOpening<T>(opening: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("The extension runtime is shutting down."));
		let tracked!: Promise<T>;
		// Defer invoking the operation until after it is registered for shutdown.
		tracked = Promise.resolve().then(opening).finally(() => this.openings.delete(tracked));
		this.openings.add(tracked);
		return tracked;
	}
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			const childDisposals = [...this.children.values()].map((child) => disposeChild(child));
			const openings = [...this.openings];
			const [childResults, openingResults] = await Promise.all([
				Promise.allSettled(childDisposals),
				Promise.allSettled(openings),
			]);
			this.children.clear();
			this.counters.clear();
			const failures = [...childResults, ...openingResults].filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not close all child sessions.");
		})();
		return this.closing;
	}
}

export async function disposeChild(child: ChildSession): Promise<void> {
	if (child.cleanup) return child.cleanup;
	// Defer teardown one microtask so concurrent/reentrant callers see the shared promise first.
	child.cleanup = Promise.resolve().then(async () => {
		// Closing the queue starts aborting this session. Start descendant teardown
		// immediately too; either side may need the other to settle.
		const closing = await Promise.allSettled([child.queue.close(), child.nestedRegistry.close()]);
		const failures = closing.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		try { await child.shutdown?.(); }
		catch (error) { failures.push(error); }
		try { child.session.dispose(); }
		catch (error) { failures.push(error); }
		if (failures.length) throw new AggregateError(failures, "Could not fully dispose a child session.");
	});
	return child.cleanup;
}
