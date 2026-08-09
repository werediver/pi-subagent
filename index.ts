import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const SubagentParams = Type.Object({
	task: Type.String({ description: "The task to give to the subagent" }),
});

export type SubagentParams = Static<typeof SubagentParams>;

export type SubagentResult = {
	status: "completed" | "failed" | "cancelled";
	text?: string;
	error?: string;
};

function getFinalAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as {
			role?: string;
			content?: Array<{ type?: string; text?: string }>;
		};

		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n\n");
		if (text) return text;
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate a task to an independent subagent and return its final message.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const abortSignal = signal ?? new AbortController().signal;
			const resourceLoader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				// No extensions also means no nested subagents.
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				model: ctx.model,
				thinkingLevel: ctx.thinkingLevel,
				resourceLoader,
				sessionManager: SessionManager.inMemory(ctx.cwd),
			});

			let aborting = false;
			const abort = () => {
				aborting = true;
				void session.abort();
			};

			if (abortSignal.aborted) abort();
			else abortSignal.addEventListener("abort", abort, { once: true });

			try {
				await session.prompt(params.task);
				if (aborting || abortSignal.aborted) {
					const result: SubagentResult = { status: "cancelled", error: "Subagent invocation was cancelled." };
					return {
						content: [{ type: "text", text: result.error ?? "Subagent invocation was cancelled." }],
						details: result,
						isError: true,
					};
				}

				const text = getFinalAssistantText(session.messages);
				const result: SubagentResult = { status: "completed", text };
				return {
					content: [{ type: "text", text: text || "(subagent returned no text)" }],
					details: result,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const result: SubagentResult = {
					status: aborting || abortSignal.aborted ? "cancelled" : "failed",
					error: message,
				};
				return {
					content: [{ type: "text", text: message }],
					details: result,
					isError: true,
				};
			} finally {
				abortSignal.removeEventListener("abort", abort);
				session.dispose();
			}
		},
	});
}
