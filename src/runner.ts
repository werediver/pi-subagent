import type { AgentSession, AgentToolUpdateCallback, Theme } from "@earendil-works/pi-coding-agent";
import { SubagentToolCallRenderer } from "./subagent-tool-renderer.ts";
import type { ChildSession } from "./registry.ts";
import { getDelegateOutcome, resultError, type DelegateCmdResult } from "./result.ts";
import { oneLine, sanitizeDisplayText } from "./text.ts";

type ActiveTool = { toolName: string; args: unknown; display?: string; toolText?: string };
type DelegateCmdProgress = { status: "running"; text?: string; currentTool?: string; currentToolArgs?: unknown; currentToolDisplay?: string; toolText?: string; turns: number };

function formatToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const values = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["path", "file_path", "command", "query", "pattern", "directory", "cwd"]) if (typeof values[key] === "string" && values[key].trim()) parts.push(`${key}: ${oneLine(values[key])}`);
	if (typeof values.offset === "number" || typeof values.limit === "number") { const range = [values.offset, values.limit].filter((value) => typeof value === "number").join(", "); if (range) parts.push(`range: ${range}`); }
	return parts.length ? ` (${parts.join("; ")})` : "";
}

function formatProgress(progress: DelegateCmdProgress): string {
	const text = [progress.text, progress.currentTool ? `Subagent is using ${progress.currentToolDisplay || `${oneLine(progress.currentTool)}${formatToolArgs(progress.currentToolArgs)}`} (turn ${progress.turns})...` : undefined, progress.toolText ? `Tool output:\n${progress.toolText}` : undefined].filter((section): section is string => Boolean(section)).join("\n\n") || `Subagent is thinking (turn ${progress.turns})...`;
	return sanitizeDisplayText(text);
}

function getAssistantProgressText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return "";
	return sanitizeDisplayText(message.content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "thinking" && typeof part.thinking === "string" ? `Thinking:\n${part.thinking}` : "").filter(Boolean).join("\n\n"));
}

function getToolProgressText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	return sanitizeDisplayText(result.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n\n"));
}

export async function runChildRequest(child: ChildSession, input: string, signal: AbortSignal, onUpdate: AgentToolUpdateCallback | undefined, theme: Theme | undefined, cwd: string): Promise<DelegateCmdResult> {
	let aborting = false, turns = 0, lastProgressText: string | undefined;
	const activeTools = new Map<string, ActiveTool>();
	let currentToolCallId: string | undefined;
	const renderer = theme ? new SubagentToolCallRenderer(child.session, theme, cwd) : undefined;
	const getCurrentTool = () => currentToolCallId ? activeTools.get(currentToolCallId) : undefined;
	const emitProgress = () => {
		const current = getCurrentTool();
		onUpdate?.({
			content: [{ type: "text", text: formatProgress({ status: "running", text: lastProgressText, currentTool: current?.toolName, currentToolArgs: current?.args, currentToolDisplay: current?.display, toolText: current?.toolText, turns }) }],
			details: { status: "running", text: lastProgressText, currentTool: current?.toolName, currentToolArgs: current?.args, currentToolDisplay: current?.display, toolText: current?.toolText, turns, activeTools: [...activeTools.entries()].map(([toolCallId, tool]) => ({ toolCallId, toolName: tool.toolName, args: tool.args, display: tool.display, toolText: tool.toolText })) },
		});
	};
	const startIndex = child.session.messages.length;
	const unsubscribe = child.session.subscribe((event) => {
		switch (event.type) {
			case "turn_start": turns++; emitProgress(); break;
			case "message_start": if (event.message.role === "assistant") { lastProgressText = undefined; emitProgress(); } break;
			case "message_update": if (event.message.role === "assistant") { const partial = "partial" in event.assistantMessageEvent ? event.assistantMessageEvent.partial : event.message; const text = getAssistantProgressText(partial); if (text) lastProgressText = text; emitProgress(); } break;
			case "tool_execution_start": {
				const display = renderer?.renderCall(event.toolCallId, event.toolName, event.args);
				activeTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, display });
				currentToolCallId = event.toolCallId;
				activeTools.get(event.toolCallId)!.toolText = undefined;
				emitProgress();
				break;
			}
			case "tool_execution_update": {
				const active = activeTools.get(event.toolCallId);
				const toolName = active?.toolName ?? event.toolName;
				const args = active?.args ?? event.args;
				const rendered = renderer?.renderResult(event.toolCallId, toolName, args, event.partialResult, true, false);
				const fallback = getToolProgressText(event.partialResult);
				const text = rendered === undefined ? fallback : rendered;
				if (active) active.toolText = text;
				currentToolCallId = event.toolCallId;
				emitProgress();
				break;
			}
			case "tool_execution_end": {
				const active = activeTools.get(event.toolCallId);
				const rendered = renderer?.renderResult(event.toolCallId, active?.toolName ?? event.toolName, active?.args, event.result, false, event.isError);
				const fallback = getToolProgressText(event.result);
				const text = rendered === undefined ? fallback : rendered;
				if (active) active.toolText = text;
				emitProgress();
				renderer?.finish(event.toolCallId);
				activeTools.delete(event.toolCallId);
				if (currentToolCallId === event.toolCallId) currentToolCallId = [...activeTools.keys()].at(-1);
				break;
			}
		}
	});
	let abortCleanup: Promise<void> | undefined;
	const abort = () => { aborting = true; abortCleanup ??= child.session.abort().catch(() => { }); };
	if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	try {
		await child.session.prompt(input);
		return getDelegateOutcome(child.session.messages.slice(startIndex), aborting || signal.aborted);
	} catch (error) {
		return resultError(aborting || signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
	} finally {
		signal.removeEventListener("abort", abort);
		if (abortCleanup) await abortCleanup;
		renderer?.clear();
		unsubscribe();
		activeTools.clear();
	}
}
