import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionConfig } from "./config.ts";

type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type AgentDefinition = {
	readonly name: string;
	readonly description?: string;
	readonly prompt: string;
	readonly tools: readonly { readonly pattern: string; readonly enabled: boolean }[];
	readonly model?: { readonly kind: "preset" | "id"; readonly name: string; readonly provider?: string };
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly skills: { readonly allowDiscovery: boolean; readonly preload: readonly string[] };
};
export type AgentDiagnostic = { readonly filename: string; readonly reason: string };
export type AgentSnapshot = {
	readonly definitions: readonly AgentDefinition[];
	readonly config: DeepReadonly<ExtensionConfig>;
	readonly diagnostics: readonly AgentDiagnostic[];
};

/** Ordered file contents and read errors captured before skills are available. */
export type AgentSources = {
	readonly sources: readonly ({ readonly filename: string; readonly content: string } | AgentDiagnostic)[];
	readonly config: DeepReadonly<ExtensionConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Copy rather than freeze caller-owned objects. defineProperty also preserves __proto__ as data.
function immutableCopy<T>(value: T): DeepReadonly<T> {
	if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as DeepReadonly<T>;
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, { value: immutableCopy(item), enumerable: true });
		return Object.freeze(result) as DeepReadonly<T>;
	}
	return value as DeepReadonly<T>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function parseDefinition(content: string, config: DeepReadonly<ExtensionConfig>, skillNames: ReadonlySet<string>, report: (reason: string) => void): AgentDefinition {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) throw new Error("expected an opening --- frontmatter delimiter on its own line");
	// Pi treats a missing delimiter as ordinary body text, so validate it first.
	const end = normalized.indexOf("\n---", 3);
	if (end < 0 || (normalized[end + 4] !== undefined && normalized[end + 4] !== "\n")) throw new Error("expected a closing --- frontmatter delimiter on its own line");
	// Pi returns JavaScript objects: integer-index-like keys in tools are enumerated
	// before other keys, regardless of their order in the YAML source.
	const { frontmatter, body } = parseFrontmatter(normalized);
	if (!isRecord(frontmatter)) throw new Error("frontmatter must be a mapping");
	const known = new Set(["name", "description", "tools", "model", "provider", "thinkingLevel", "skills"]);
	for (const key of Object.keys(frontmatter)) if (!known.has(key)) report(`unknown frontmatter field ${JSON.stringify(key)} (ignored)`);
	const name = requiredString(frontmatter.name, "name");
	const description = Object.hasOwn(frontmatter, "description") ? requiredString(frontmatter.description, "description") : undefined;
	if (description?.includes("\n") || description?.includes("\r")) throw new Error("description must be one line");
	const rules: { pattern: string; enabled: boolean }[] = [];
	if (Object.hasOwn(frontmatter, "tools")) {
		if (!isRecord(frontmatter.tools)) throw new Error("tools must be a mapping of patterns to booleans");
		for (const [pattern, enabled] of Object.entries(frontmatter.tools)) {
			if (!pattern.trim() || typeof enabled !== "boolean") throw new Error(`invalid tools rule ${JSON.stringify(pattern)}; expected a non-empty pattern and boolean`);
			rules.push({ pattern, enabled });
		}
	}
	const modelName = Object.hasOwn(frontmatter, "model") ? requiredString(frontmatter.model, "model") : undefined;
	const provider = Object.hasOwn(frontmatter, "provider") ? requiredString(frontmatter.provider, "provider") : undefined;
	const preset = modelName !== undefined && (modelName === "parent" || modelName === "main" || Object.hasOwn(config.agentPresets, modelName));
	if (provider && (!modelName || preset)) throw new Error("provider is allowed only for a concrete model ID");
	const model = modelName === undefined ? undefined : { kind: preset ? "preset" as const : "id" as const, name: modelName, ...(provider ? { provider } : {}) };
	const thinkingLevel = frontmatter.thinkingLevel;
	if (Object.hasOwn(frontmatter, "thinkingLevel") && (typeof thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel))) throw new Error("invalid thinkingLevel");
	let allowDiscovery = true;
	let preload: string[] = [];
	if (Object.hasOwn(frontmatter, "skills")) {
		if (!isRecord(frontmatter.skills)) throw new Error("skills must be a mapping");
		const skills = frontmatter.skills;
		for (const key of Object.keys(skills)) if (key !== "allowDiscovery" && key !== "preload") report(`unknown skills field ${JSON.stringify(key)} (ignored)`);
		if (Object.hasOwn(skills, "allowDiscovery")) {
			if (typeof skills.allowDiscovery !== "boolean") throw new Error("skills.allowDiscovery must be a boolean");
			allowDiscovery = skills.allowDiscovery;
		}
		if (Object.hasOwn(skills, "preload")) {
			if (!Array.isArray(skills.preload)) throw new Error("skills.preload must be an array of skill names");
			preload = skills.preload.map((value) => requiredString(value, "skills.preload name"));
			for (const skill of preload) if (!skillNames.has(skill)) throw new Error(`unknown preloaded skill ${JSON.stringify(skill)}`);
		}
	}
	return { name, ...(description === undefined ? {} : { description }), prompt: body, tools: rules, ...(model === undefined ? {} : { model }), ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ModelThinkingLevel }), skills: { allowDiscovery, preload } };
}

export function captureAgentSources(options: { cwd: string; agentDir: string; trusted: boolean; config: ExtensionConfig }): AgentSources {
	const config = immutableCopy(options.config);
	const sources: ({ filename: string; content: string } | AgentDiagnostic)[] = [];
	const directories = [...(options.trusted ? [join(options.cwd, CONFIG_DIR_NAME, "agents")] : []), join(options.agentDir, "agents")];
	for (const directory of directories) {
		let files: string[];
		try {
			files = readdirSync(directory, { withFileTypes: true }).filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")).map((entry) => join(directory, entry.name)).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") sources.push({ filename: directory, reason: `could not read agents directory: ${String(error)}` });
			continue;
		}
		for (const filename of files) {
			try { sources.push({ filename, content: readFileSync(filename, "utf8") }); }
			catch (error) { sources.push({ filename, reason: error instanceof Error ? error.message : String(error) }); }
		}
	}
	return immutableCopy({ sources, config });
}

export function buildAgentSnapshot(capture: AgentSources, skillNames: readonly string[]): AgentSnapshot {
	const skills = new Set(skillNames);
	const definitions: AgentDefinition[] = [];
	const diagnostics: AgentDiagnostic[] = [];
	const names = new Set<string>();
	for (const source of capture.sources) {
		if (!("content" in source)) { diagnostics.push(source); continue; }
		const { filename, content } = source;
		try {
			const definition = parseDefinition(content, capture.config, skills, (reason) => diagnostics.push({ filename, reason }));
			if (names.has(definition.name)) { diagnostics.push({ filename, reason: `duplicate agent name ${JSON.stringify(definition.name)} (ignored)` }); continue; }
			names.add(definition.name);
			definitions.push(definition);
		} catch (error) { diagnostics.push({ filename, reason: error instanceof Error ? error.message : String(error) }); }
	}
	return immutableCopy({ definitions, config: capture.config, diagnostics });
}

export function discoverAgentSnapshot(options: { cwd: string; agentDir: string; trusted: boolean; config: ExtensionConfig; skillNames: readonly string[] }): AgentSnapshot {
	return buildAgentSnapshot(captureAgentSources(options), options.skillNames);
}
