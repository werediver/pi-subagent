import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	CONFIG_DIR_NAME,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ModelClassDefinition =
	| { model: string; provider?: string; thinkingLevel?: ModelThinkingLevel; description?: string }
	| { base: string; thinkingLevel?: ModelThinkingLevel; description?: string }
	| { description: string };

export type ExtensionConfig = { modelClasses: Record<string, ModelClassDefinition>; subagentPreamble?: string };

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
	if (value === undefined) return { modelClasses: {} };
	if (!isRecord(value)) throw new Error(`Extension configuration at ${path} must be a JSON object.`);
	const subagentPreamble = value.subagentPreamble;
	if (subagentPreamble !== undefined && typeof subagentPreamble !== "string") throw new Error(`The subagentPreamble property in ${path} must be a string.`);
	if (value.modelClasses === undefined) return { modelClasses: {}, ...(subagentPreamble === undefined ? {} : { subagentPreamble }) };
	if (!isRecord(value.modelClasses)) throw new Error(`The modelClasses property in ${path} must be a JSON object.`);
	const modelClasses: Record<string, ModelClassDefinition> = {};
	for (const [name, raw] of Object.entries(value.modelClasses)) {
		if (!isRecord(raw)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} must be an object.`);
		const allowedKeys = new Set(["model", "provider", "base", "thinkingLevel", "description"]);
		for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an unknown property ${JSON.stringify(key)}.`);
		const stringValue = (key: string): string | undefined => {
			if (!(key in raw)) return undefined;
			if (typeof raw[key] !== "string") throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid ${key}.`);
			const value = (raw[key] as string).trim();
			if (!value) throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid ${key}.`);
			return value;
		};
		const base = stringValue("base");
		const model = stringValue("model");
		const provider = stringValue("provider");
		const description = stringValue("description");
		const thinkingLevel = raw.thinkingLevel === undefined ? undefined : raw.thinkingLevel;
		if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid thinkingLevel.`);
		if (name === "parent" || name === "main") {
			if (model || base || provider || thinkingLevel || !description) throw new Error(`Built-in model class ${JSON.stringify(name)} in ${path} may only specify a description.`);
			modelClasses[name] = { description };
			continue;
		}
		if ((model !== undefined) === (base !== undefined)) throw new Error(`Model class ${JSON.stringify(name)} in ${path} must define exactly one of model or base.`);
		if (base !== undefined && provider !== undefined) throw new Error(`Model class ${JSON.stringify(name)} in ${path} cannot specify a provider when using a base class.`);
		modelClasses[name] = base !== undefined
			? { base, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }) }
			: { model: model!, ...(provider === undefined ? {} : { provider }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(description === undefined ? {} : { description }) };
	}
	return { modelClasses, ...(subagentPreamble === undefined ? {} : { subagentPreamble }) };
}

export function loadExtensionConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExtensionConfig {
	const globalPath = join(getAgentDir(), "subagent.json");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "subagent.json");
	const globalConfig = parseExtensionConfig(readJsonFile(globalPath), globalPath);
	const projectConfig = parseExtensionConfig(ctx.isProjectTrusted() ? readJsonFile(projectPath) : undefined, projectPath);
	const subagentPreamble = projectConfig.subagentPreamble ?? globalConfig.subagentPreamble;
	return {
		modelClasses: { ...globalConfig.modelClasses, ...projectConfig.modelClasses },
		...(subagentPreamble === undefined ? {} : { subagentPreamble }),
	};
}
