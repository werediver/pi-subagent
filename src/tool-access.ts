export type ToolAccessRule = { pattern: string; enabled: boolean };

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