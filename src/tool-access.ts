import type { ExtensionConfig, ToolAccessRules } from "./config.ts";
import { AgentPresetError } from "./model-resolver.ts";

export type ToolAccessRule = { pattern: string; enabled: boolean };

function toRules(rules: ToolAccessRules | undefined): ToolAccessRule[] {
	return rules === undefined ? [] : Object.entries(rules).map(([pattern, enabled]) => ({ pattern, enabled }));
}

/**
 * Resolve the ordered tool access rules for an agent preset.
 * A preset that derives from a `base` inherits the base's rules first, so the
 * derived preset's own rules layer on top under last-match-wins evaluation.
 */
export function resolveToolAccessRules(requestedPreset: string | undefined, config: ExtensionConfig): ToolAccessRule[] {
	const name = requestedPreset?.trim() || "parent";
	const resolving = new Set<string>();
	const resolve = (presetName: string): ToolAccessRule[] => {
		if (resolving.has(presetName)) throw new AgentPresetError(`Circular agent preset reference involving ${JSON.stringify(presetName)}.`);
		resolving.add(presetName);
		try {
			if (presetName === "parent" || presetName === "main") return [];
			const definition = config.agentPresets[presetName];
			if (!definition) throw new AgentPresetError(`Unknown agent preset ${JSON.stringify(presetName)}. Configure it in subagent.json.`);
			const inherited = "base" in definition ? resolve(definition.base) : [];
			return [...inherited, ...toRules("tools" in definition ? definition.tools : undefined)];
		} finally {
			resolving.delete(presetName);
		}
	};
	return resolve(name);
}

function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/**
 * Evaluate ordered rules against the available tool names. Every tool starts
 * enabled; each matching rule applies its value in order, so the last matching
 * rule wins. Tools matched by no rule stay enabled.
 */
export function evaluateToolAccess(rules: readonly ToolAccessRule[], toolNames: readonly string[]): string[] {
	if (rules.length === 0) return [...toolNames];
	const compiled = rules.map((rule) => ({ ...rule, regexp: patternToRegExp(rule.pattern) }));
	const enabled = new Set(toolNames);
	for (const rule of compiled) for (const name of toolNames) if (rule.regexp.test(name)) enabled[rule.enabled ? "add" : "delete"](name);
	return toolNames.filter((name) => enabled.has(name));
}