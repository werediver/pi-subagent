import { escapeXml } from "./text.ts";

export type DelegateCmdResult = {
	status: "completed" | "failed" | "cancelled";
	sessionId?: string;
	text?: string;
	error?: string;
};

export function resultError(status: "failed" | "cancelled", error: string): DelegateCmdResult {
	return { status, error };
}

export function formatDelegateResult(result: DelegateCmdResult): string {
	const lines = ["<delegate_result>", `  <status>${escapeXml(result.status)}</status>`];
	if (result.status === "completed") {
		if (result.sessionId) lines.push(`  <session_id>${escapeXml(result.sessionId)}</session_id>`);
		if (result.text !== undefined) lines.push(`  <text>${escapeXml(result.text)}</text>`);
	} else lines.push(`  <error>${escapeXml(result.error ?? "Delegation failed.")}</error>`);
	lines.push("</delegate_result>");
	return lines.join("\n");
}

export function createDelegateToolResult(result: DelegateCmdResult) {
	return {
		content: [{ type: "text" as const, text: formatDelegateResult(result) }],
		details: result,
		...(result.status !== "completed" ? { isError: true } : {}),
	};
}

export function getAssistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return "";
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n\n");
}

export function getDelegateOutcome(messages: readonly any[], aborted: boolean): DelegateCmdResult {
	const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
	if (aborted || assistant?.stopReason === "aborted") return resultError("cancelled", assistant?.errorMessage || "Delegation was cancelled.");
	if (assistant?.stopReason === "error") return resultError("failed", assistant.errorMessage || "Delegation failed.");
	const text = assistant ? getAssistantText(assistant) : "";
	return text ? { status: "completed", text } : { status: "completed" };
}
