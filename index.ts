import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const DelegateCmdParams = Type.Object({
	task: Type.String({ description: "The task to delegate" }),
});

export type DelegateCmdParams = Static<typeof DelegateCmdParams>;

export type DelegateCmdResult = {
	status: "completed" | "failed" | "cancelled";
	text?: string;
	error?: string;
};

type DelegateCmdProgress = {
	status: "running";
	text?: string;
	currentTool?: string;
	turns: number;
};

function formatProgress(progress: DelegateCmdProgress): string {
	if (progress.currentTool) return `Subagent is using ${progress.currentTool} (turn ${progress.turns})...`;
	if (progress.text) return progress.text;
	return `Subagent is working (turn ${progress.turns})...`;
}

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
		name: "delegate",
		label: "Delegate",
		description: "Delegate a task to a subagent with a separate context window and return its final message.",
		parameters: DelegateCmdParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
			let turns = 0;
			let currentTool: string | undefined;
			let lastProgressText: string | undefined;

			const emitProgress = (message?: unknown) => {
				if (!onUpdate) return;
				const text = message ? getFinalAssistantText([message]) : undefined;
				if (text !== undefined) lastProgressText = text;
				const progress: DelegateCmdProgress = {
					status: "running",
					text: lastProgressText,
					currentTool,
					turns,
				};
				onUpdate({
					content: [{ type: "text", text: formatProgress(progress) }],
					details: progress,
				});
			};

			const unsubscribe = session.subscribe((event) => {
				switch (event.type) {
					case "turn_start":
						turns += 1;
						emitProgress();
						break;
					case "message_update":
						if (event.message && event.message.role === "assistant") emitProgress(event.message);
						break;
					case "tool_execution_start":
						currentTool = event.toolName;
						emitProgress();
						break;
					case "tool_execution_end":
						currentTool = undefined;
						emitProgress();
						break;
				}
			});

			const abort = () => {
				aborting = true;
				void session.abort();
			};

			if (abortSignal.aborted) abort();
			else abortSignal.addEventListener("abort", abort, { once: true });

			try {
				await session.prompt(params.task);
				if (aborting || abortSignal.aborted) {
					const result: DelegateCmdResult = { status: "cancelled", error: "Subagent invocation was cancelled." };
					return {
						content: [{ type: "text", text: result.error ?? "Subagent invocation was cancelled." }],
						details: result,
						isError: true,
					};
				}

				const text = getFinalAssistantText(session.messages);
				const result: DelegateCmdResult = { status: "completed", text };
				return {
					content: [{ type: "text", text: text || "(subagent returned no text)" }],
					details: result,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const result: DelegateCmdResult = {
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
				unsubscribe();
				session.dispose();
			}
		},
	});
}
