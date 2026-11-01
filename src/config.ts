import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	CONFIG_DIR_NAME,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type AgentPreset =
	| { model: string; provider?: string; thinkingLevel?: ModelThinkingLevel; description?: string }
	| { base: string; thinkingLevel?: ModelThinkingLevel; description?: string }
	| { description: string };

/**
 * Parses a configuration value that may be provided either as a single string
 * or as an array of strings, which are joined using a newline separator.
 * Returns `undefined` when the value is absent.
 */
function parseText(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" && !Array.isArray(value)) throw new Error(`${label} must be a string or an array of strings.`);
	const parts = typeof value === "string" ? [value] : value;
	const lines: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string") throw new Error(`${label} must be a string or an array of strings.`);
		const line = part.trimEnd();
		lines.push(line);
	}
	if (lines.length === 0) throw new Error(`${label} must not be empty.`);
	return lines.join("\n");
}

export type ExtensionConfig = { agentPresets: Record<string, AgentPreset> };

function readJsonFile(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf-8")); }
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Could not read extension configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function parseExtensionConfig(value: unknown, path: string, warn: (message: string) => void = (message) => console.warn(message)): ExtensionConfig {
	const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
	const isThinkingLevel = (item: unknown): item is ModelThinkingLevel => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item as string);
	if (value === undefined) return { agentPresets: {} };
	if (!isRecord(value)) throw new Error(`Extension configuration at ${path} must be a JSON object.`);
	if ("subagentPreamble" in value) warn(`The subagentPreamble property in ${path} has been removed and is ignored; move its content to an agent definition.`);
	if (value.agentPresets === undefined) return { agentPresets: {} };
	if (!isRecord(value.agentPresets)) throw new Error(`The agentPresets property in ${path} must be a JSON object.`);
	const agentPresets: Record<string, AgentPreset> = {};
	for (const [name, raw] of Object.entries(value.agentPresets)) {
		if (!isRecord(raw)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} must be an object.`);
		if ("tools" in raw) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} uses removed tools rules; move tools to an agent definition.`);
		const allowedKeys = new Set(["model", "provider", "base", "thinkingLevel", "description"]);
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
		const description = parseText(raw.description, `The description property of agent preset ${JSON.stringify(name)} in ${path}`);
		const thinkingLevel = raw.thinkingLevel === undefined ? undefined : raw.thinkingLevel;
		if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} has an invalid thinkingLevel.`);
		if (name === "parent" || name === "main") {
			if (model || base || provider || thinkingLevel || !description) throw new Error(`Built-in agent preset ${JSON.stringify(name)} in ${path} may only specify a description.`);
			agentPresets[name] = { description };
			continue;
		}
		if ((model !== undefined) === (base !== undefined)) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} must define exactly one of model or base.`);
		if (base !== undefined && provider !== undefined) throw new Error(`Agent preset ${JSON.stringify(name)} in ${path} cannot specify a provider when using a base preset.`);
		agentPresets[name] = base !== undefined
			? { base, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }) }
			: { model: model!, ...(provider === undefined ? {} : { provider }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }) };
	}
	return { agentPresets };
}

export function loadExtensionConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & Partial<Pick<ExtensionContext, "hasUI" | "ui">>): ExtensionConfig {
	const globalPath = join(getAgentDir(), "subagent.json");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "subagent.json");
	const warn = (message: string) => {
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, "warning");
		else console.warn(message);
	};
	const globalConfig = parseExtensionConfig(readJsonFile(globalPath), globalPath, warn);
	const projectConfig = parseExtensionConfig(ctx.isProjectTrusted() ? readJsonFile(projectPath) : undefined, projectPath, warn);
	return { agentPresets: { ...globalConfig.agentPresets, ...projectConfig.agentPresets } };
}
