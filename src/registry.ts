import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ContinuationQueue } from "./queue.ts";

export type ChildSession = {
	session: AgentSession;
	cwd: string;
	queue: ContinuationQueue;
	nestedRegistry: ChildRegistry;
	cleanup?: Promise<void>;
};

export class ChildRegistry {
	private readonly children = new Map<string, ChildSession>();
	private readonly setups = new Set<Promise<unknown>>();
	private closed = false;
	private closing: Promise<void> | undefined;

	isClosed(): boolean { return this.closed; }
	get(id: string): ChildSession | undefined { return this.children.get(id); }
	add(child: ChildSession): void {
		if (this.closed) throw new Error("The extension runtime is shutting down.");
		this.children.set(child.session.sessionId, child);
	}
	remove(id: string, child: ChildSession): void {
		if (this.children.get(id) === child) this.children.delete(id);
	}
	trackSetup<T>(setup: Promise<T>): Promise<T> {
		this.setups.add(setup);
		return setup.finally(() => this.setups.delete(setup));
	}
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			await Promise.all([...this.children.values()].map((child) => disposeChild(child)));
			await Promise.allSettled([...this.setups]);
			this.children.clear();
		})();
		return this.closing;
	}
}

export async function disposeChild(child: ChildSession): Promise<void> {
	if (child.cleanup) return child.cleanup;
	child.cleanup = (async () => {
		await child.nestedRegistry.close();
		await child.queue.close();
		child.session.dispose();
	})();
	return child.cleanup;
}
