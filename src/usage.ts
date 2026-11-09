import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

type AgentReportedUsage = NonNullable<AgentToolResult<unknown>["usage"]>;
export type ReportedUsage = Omit<AgentReportedUsage, "cost"> & {
	cost: AgentReportedUsage["cost"] & { totalFromProvider?: boolean };
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isReportedUsage(value: unknown): value is ReportedUsage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens,
		value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total]
		.every(isFiniteNumber);
}

function getEntryUsage(entry: unknown): ReportedUsage | undefined {
	if (!isRecord(entry)) return undefined;
	if (entry.type === "message" && isRecord(entry.message)) {
		const message = entry.message;
		if (message.role !== "assistant" && message.role !== "toolResult") return undefined;
		return isReportedUsage(message.usage) ? message.usage : undefined;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return isReportedUsage(entry.usage) ? entry.usage : undefined;
	}
	// Standalone UsageEntry/cache-warm records are intentionally unassignable to a
	// delegation invocation and are excluded, even if they occur in this snapshot.
	return undefined;
}

/** Sum usage carried by attributable entries from one serialized invocation. */
export function aggregateUsageEntries(entries: readonly unknown[]): ReportedUsage | undefined {
	const total: ReportedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let found = false;
	let hasCacheWrite1h = false;
	let hasReasoning = false;
	let cacheWrite1h = 0;
	let reasoning = 0;
	let allCostsProviderReported = true;

	for (const entry of entries) {
		const usage = getEntryUsage(entry);
		if (!usage) continue;
		found = true;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
		allCostsProviderReported &&= usage.cost.totalFromProvider === true;
		if (isFiniteNumber(usage.cacheWrite1h)) {
			hasCacheWrite1h = true;
			cacheWrite1h += usage.cacheWrite1h;
		}
		if (isFiniteNumber(usage.reasoning)) {
			hasReasoning = true;
			reasoning += usage.reasoning;
		}
	}

	if (!found) return undefined;
	if (hasCacheWrite1h) total.cacheWrite1h = cacheWrite1h;
	if (hasReasoning) total.reasoning = reasoning;
	if (allCostsProviderReported) total.cost.totalFromProvider = true;
	return total;
}
