import type { AgentSession, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";

type ToolCallRendererState = {
	state: Record<string, unknown>;
	args?: unknown;
	callComponent?: Component;
	resultComponent?: Component;
};

function disposeComponent(component: Component | undefined, disposed = new Set<Component>()): void {
	if (!component || disposed.has(component)) return;
	disposed.add(component);
	(component as Component & { dispose?: () => void }).dispose?.();
}

function cleanRenderedLines(lines: readonly string[]): string {
	const cleaned = lines.map((line) => stripTerminalSequences(line).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""));
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
		state.args = args;
		try {
			const component = renderCall(args as never, this.theme, this.createContext(toolCallId, args, state.callComponent, true, false, false));
			if (component !== state.callComponent) disposeComponent(state.callComponent);
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
		const effectiveArgs = args ?? state.args;
		try {
			const component = renderResult(
				result as never,
				// Nested output has no independent ToolExecutionComponent, so there is
				// no Ctrl+O interaction that could reveal a collapsed result. Render
				// the expanded variant instead; renderers use this to omit expansion
				// hints and include the complete available output.
				{ expanded: true, isPartial },
				this.theme,
				this.createContext(toolCallId, effectiveArgs, state.resultComponent, isPartial, isError, false),
			);
			if (component !== state.resultComponent) disposeComponent(state.resultComponent);
			state.resultComponent = component;
			return cleanRenderedLines(component.render(this.width));
		} catch {
			return undefined;
		}
	}

	finish(toolCallId: string): void {
		const state = this.calls.get(toolCallId);
		if (state) {
			const disposed = new Set<Component>();
			disposeComponent(state.callComponent, disposed);
			disposeComponent(state.resultComponent, disposed);
		}
		this.calls.delete(toolCallId);
	}

	clear(): void {
		const disposed = new Set<Component>();
		for (const state of this.calls.values()) {
			disposeComponent(state.callComponent, disposed);
			disposeComponent(state.resultComponent, disposed);
		}
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
		expanded: boolean,
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
			expanded,
			showImages: false,
			isError,
		};
	}
}
