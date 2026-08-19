import type { AgentSession, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type ToolCallRendererState = {
	state: Record<string, unknown>;
	callComponent?: Component;
	resultComponent?: Component;
};

const ANSI_ESCAPE_REGEX = /\x1b\[[0-?]*[ -\/]*[@-~]/g;

function cleanRenderedLines(lines: readonly string[]): string {
	const cleaned = lines.map((line) => line.replace(ANSI_ESCAPE_REGEX, ""));
	let start = 0;
	let end = cleaned.length;
	while (start < end && cleaned[start].trim() === "") start++;
	while (end > start && cleaned[end - 1].trim() === "") end--;
	return cleaned.slice(start, end).join("\n");
}

/**
 * Adapts registered tool renderers to the nested session's progress updates.
 * Nested sessions do not have their own interactive TUI, so renderer
 * components are rendered to plain text instead of being mounted as rows.
 */
export class SubagentToolCallRenderer {
	private readonly calls = new Map<string, ToolCallRendererState>();

	constructor(
		private readonly session: Pick<AgentSession, "getToolDefinition">,
		private readonly theme: Theme,
		private readonly cwd: string,
		private readonly width = 100,
	) {}

	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
		const definition = this.session.getToolDefinition(toolName);
		const renderCall = definition?.renderCall as ToolDefinition["renderCall"] | undefined;
		if (!renderCall) return undefined;

		const state = this.getState(toolCallId);
		try {
			const component = renderCall(args as never, this.theme, this.createContext(toolCallId, args, state.callComponent, true, false));
			state.callComponent = component;
			return cleanRenderedLines(component.render(this.width));
		} catch {
			return undefined;
		}
	}

	renderResult(
		toolCallId: string,
		toolName: string,
		args: unknown,
		result: unknown,
		isPartial: boolean,
		isError: boolean,
	): string | undefined {
		const definition = this.session.getToolDefinition(toolName);
		const renderResult = definition?.renderResult as ToolDefinition["renderResult"] | undefined;
		if (!renderResult) return undefined;

		const state = this.getState(toolCallId);
		try {
			const component = renderResult(
				result as never,
				// Nested output has no independent ToolExecutionComponent, so there is
				// no Ctrl+O interaction that could reveal a collapsed result. Render
				// the expanded variant instead; renderers use this to omit expansion
				// hints and include the complete available output.
				{ expanded: true, isPartial },
				this.theme,
				this.createContext(toolCallId, args, state.resultComponent, isPartial, isError),
			);
			state.resultComponent = component;
			return cleanRenderedLines(component.render(this.width));
		} catch {
			return undefined;
		}
	}

	finish(toolCallId: string): void {
		this.calls.delete(toolCallId);
	}

	clear(): void {
		this.calls.clear();
	}

	private getState(toolCallId: string): ToolCallRendererState {
		let state = this.calls.get(toolCallId);
		if (!state) {
			state = { state: {} };
			this.calls.set(toolCallId, state);
		}
		return state;
	}

	private createContext(
		toolCallId: string,
		args: unknown,
		lastComponent: Component | undefined,
		isPartial: boolean,
		isError: boolean,
	) {
		return {
			args,
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: this.getState(toolCallId).state,
			cwd: this.cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded: false,
			showImages: false,
			isError,
		};
	}
}
