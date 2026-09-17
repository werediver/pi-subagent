import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	CONFIG_DIR_NAME,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ToolAccessRules = Record<string, boolean>;

export type AgentPreset =
	| { model: string; provider?: string; thinkingLevel?: ModelThinkingLevel; description?: string; tools?: ToolAccessRules }
	| { base: string; thinkingLevel?: ModelThinkingLevel; description?: string; tools?: ToolAccessRules }
	| { description: string };

function parseToolAccessRules(value: unknown, presetName: string, path: string): ToolAccessRules | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Agent preset ${JSON.stringify(presetName)} in ${path} has an invalid tools; expected an object mapping tool patterns to booleans.`);
	const rules: ToolAccessRules = {};
	for (const [pattern, enabled] of Object.entries(value)) {
		if (!pattern.trim()) throw new Error(`Agent preset ${JSON.stringify(presetName)} in ${path} has an empty tools pattern.`);
		if (typeof enabled !== "boolean") throw new Error(`Agent preset ${JSON.stringify(presetName)} in ${path} has a non-boolean value for the tools pattern ${JSON.stringify(pattern)}.`);
		rules[pattern] = enabled;
	}
	return rules;
}

export type ExtensionConfig = { agentPresets: Record<string, AgentPreset>; subagentPreamble?: string };

function readJsonFile(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf-8")); }
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Could not read extension configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function parseExtensionConfig(value: unknown, path: string): ExtensionConfig {
	const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
	const isThinkingLevel = (item: unknown): item is ModelThinkingLevel => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item as string);
	if (value === undefined) return { agentPresets: {} };
	if (!isRecord(value)) throw new Error(`Extension configuration at ${path} must be a JSON object.`);
	const subagentPreamble = value.subagentPreamble;
	if (subagentPreamble !== undefined && typeof subagentPreamble !== "string") throw new Error(`The subagentPreamble property in ${path} must be a string.`);
	if (value.agentPresets === undefined) return { agentPresets: {}, ...(subagentPreamble === undefined ? {} : { subagentPreamble }) };
	if (!isRecord(value.agentPresets)) throw new Error(`The agentPresets property in ${path} must be a JSON object.`);
	const agentPresets: Record<string, AgentPreset> = {};
	for (const [name, raw] of Object.entries(value.agentPresets)) {
		if (!isRecord(raw)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} must be an object.`);
		const allowedKeys = new Set(["model", "provider", "base", "thinkingLevel", "description", "tools"]);
		for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} has an unknown property ${JSON.stringify(key)}.`);
		const stringValue = (key: string): string | undefined => {
			if (!(key in raw)) return undefined;
			if (typeof raw[key] !== "string") throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} has an invalid ${key}.`);
			const value = (raw[key] as string).trim();
			if (!value) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} has an invalid ${key}.`);
			return value;
		};
		const base = stringValue("base");
		const model = stringValue("model");
		const provider = stringValue("provider");
		const description = stringValue("description");
		const thinkingLevel = raw.thinkingLevel === undefined ? undefined : raw.thinkingLevel;
		if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} has an invalid thinkingLevel.`);
		const tools = parseToolAccessRules(raw.tools, name, path);
		if (name === "parent" || name === "main") {
			if (model || base || provider || thinkingLevel || tools || !description) throw new Error(`Built-in agent preset ${JSON.stringify(name)} in ${path} may only specify a description.`);
			agentPresets[name] = { description };
			continue;
		}
		if ((model !== undefined) === (base !== undefined)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} must define exactly one of model or base.`);
		if (base !== undefined && provider !== undefined) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} cannot specify a provider when using a base preset.`);
		agentPresets[name] = base !== undefined
			? { base, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }), ...(tools === undefined ? {} : { tools }) }
			: { model: model!, ...(provider === undefined ? {} : { provider }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }), ...(tools === undefined ? {} : { tools }) };
	}
	return { agentPresets, ...(subagentPreamble === undefined ? {} : { subagentPreamble }) };
}

export function loadExtensionConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExtensionConfig {
	const globalPath = join(getAgentDir(), "subagent.json");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "subagent.json");
	const globalConfig = parseExtensionConfig(readJsonFile(globalPath), globalPath);
	const projectConfig = parseExtensionConfig(ctx.isProjectTrusted() ? readJsonFile(projectPath) : undefined, projectPath);
	const subagentPreamble = projectConfig.subagentPreamble ?? globalConfig.subagentPreamble;
	return {
		agentPresets: { ...globalConfig.agentPresets, ...projectConfig.agentPresets },
		...(subagentPreamble === undefined ? {} : { subagentPreamble }),
	};
}
