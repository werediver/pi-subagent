import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export type AgentModelCandidate = { readonly id: string; readonly provider?: string; readonly thinkingLevel?: ModelThinkingLevel };

export type AgentDefinition = {
	readonly filename: string;
	readonly name: string;
	readonly description?: string;
	readonly prompt: string;
	readonly tools: readonly { readonly pattern: string; readonly enabled: boolean }[];
	readonly model?: readonly AgentModelCandidate[];
	readonly skills: { readonly allowDiscovery: boolean; readonly preload: readonly string[] };
};
export type AgentDiagnostic = { readonly filename: string; readonly reason: string };
export type AgentSnapshot = {
	readonly definitions: readonly AgentDefinition[];
	readonly diagnostics: readonly AgentDiagnostic[];
};
export type AgentPreflight = {
	readonly modelDefinitions: readonly AgentDefinition[];
	readonly diagnostics: readonly AgentDiagnostic[];
};

/** Ordered file contents and read errors captured before skills are available. */
export type AgentSources = {
	readonly sources: readonly ({ readonly filename: string; readonly content: string } | AgentDiagnostic)[];
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

const validThinkingLevels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseModelCandidate(value: unknown, field: string): AgentModelCandidate {
	if (!isRecord(value)) throw new Error(`${field} must be a mapping with id and optional provider and thinkingLevel`);
	for (const key of Object.keys(value)) if (key !== "id" && key !== "provider" && key !== "thinkingLevel") throw new Error(`${field} has unsupported field ${JSON.stringify(key)}; expected only id, provider and thinkingLevel`);
	const id = requiredString(value.id, `${field}.id`);
	const provider = Object.hasOwn(value, "provider") ? requiredString(value.provider, `${field}.provider`) : undefined;
	const thinkingLevel = Object.hasOwn(value, "thinkingLevel") ? value.thinkingLevel : undefined;
	if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !validThinkingLevels.includes(thinkingLevel as ModelThinkingLevel))) throw new Error(`invalid ${field}.thinkingLevel; expected one of ${validThinkingLevels.join(", ")}`);
	return { id, ...(provider === undefined ? {} : { provider }), ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ModelThinkingLevel }) };
}

function parseModel(value: unknown): readonly AgentModelCandidate[] {
	if (typeof value === "string") return [{ id: requiredString(value, "model") }];
	if (Array.isArray(value)) {
		if (value.length === 0) throw new Error("model candidate list must not be empty");
		return value.map((candidate, index) => typeof candidate === "string"
			? { id: requiredString(candidate, `model[${index}]`) }
			: parseModelCandidate(candidate, `model[${index}]`));
	}
	return [parseModelCandidate(value, "model")];
}

function parseDefinition(filename: string, content: string, skillNames: ReadonlySet<string> | undefined, report: (reason: string) => void): AgentDefinition {
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
	if (Object.hasOwn(frontmatter, "provider")) throw new Error("top-level provider is no longer supported; migrate model: x + provider: p to model: { id: x, provider: p }");
	if (Object.hasOwn(frontmatter, "thinkingLevel")) throw new Error("top-level thinkingLevel is no longer supported; migrate model: x + thinkingLevel: high to model: { id: x, thinkingLevel: high }; for a model list, put it on each intended candidate. When model is omitted, the caller's model and thinking level are inherited unchanged.");
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
	const model = Object.hasOwn(frontmatter, "model") ? parseModel(frontmatter.model) : undefined;
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
			if (skillNames) for (const skill of preload) if (!skillNames.has(skill)) throw new Error(`unknown preloaded skill ${JSON.stringify(skill)}`);
		}
	}
	return { filename, name, ...(description === undefined ? {} : { description }), prompt: body, tools: rules, ...(model === undefined ? {} : { model }), skills: { allowDiscovery, preload } };
}

export function captureAgentSources(options: { cwd: string; agentDir: string; trusted: boolean }): AgentSources {
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
	return immutableCopy({ sources });
}

export function preflightAgentSources(capture: AgentSources): AgentPreflight {
	type Entry = { readonly filename: string; readonly definition?: AgentDefinition; readonly catalogDependent: boolean; readonly diagnostics: AgentDiagnostic[] };
	const entries: Entry[] = [];
	for (const source of capture.sources) {
		if (!("content" in source)) {
			entries.push({ filename: source.filename, catalogDependent: false, diagnostics: [source] });
			continue;
		}
		const diagnostics: AgentDiagnostic[] = [];
		try {
			const definition = parseDefinition(source.filename, source.content, undefined, (reason) => diagnostics.push({ filename: source.filename, reason }));
			entries.push({ filename: source.filename, definition, catalogDependent: definition.skills.preload.length > 0, diagnostics });
		} catch (error) {
			diagnostics.push({ filename: source.filename, reason: error instanceof Error ? error.message : String(error) });
			entries.push({ filename: source.filename, catalogDependent: false, diagnostics });
		}
	}

	const byName = new Map<string, Entry[]>();
	for (const entry of entries) {
		if (!entry.definition) continue;
		const group = byName.get(entry.definition.name) ?? [];
		group.push(entry);
		byName.set(entry.definition.name, group);
	}
	const modelDefinitions: AgentDefinition[] = [];
	for (const [name, group] of byName) {
		if (group.length === 1) {
			modelDefinitions.push(group[0].definition!);
			continue;
		}
		let uncertainWinner = false;
		let guaranteedWinner = false;
		for (const entry of group) {
			if (entry.catalogDependent) {
				if (!guaranteedWinner) uncertainWinner = true;
				continue;
			}
			if (guaranteedWinner) {
				entry.diagnostics.push({ filename: entry.filename, reason: `duplicate agent name ${JSON.stringify(name)} (ignored)` });
			} else if (uncertainWinner) {
				// This entry is either the winner or a duplicate depending on earlier skill validation.
				guaranteedWinner = true;
			} else {
				guaranteedWinner = true;
				modelDefinitions.push(entry.definition!);
			}
		}
	}
	return immutableCopy({ modelDefinitions, diagnostics: entries.flatMap((entry) => entry.diagnostics) });
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
			const definition = parseDefinition(filename, content, skills, (reason) => diagnostics.push({ filename, reason }));
			if (names.has(definition.name)) { diagnostics.push({ filename, reason: `duplicate agent name ${JSON.stringify(definition.name)} (ignored)` }); continue; }
			names.add(definition.name);
			definitions.push(definition);
		} catch (error) { diagnostics.push({ filename, reason: error instanceof Error ? error.message : String(error) }); }
	}
	return immutableCopy({ definitions, diagnostics });
}

export function discoverAgentSnapshot(options: { cwd: string; agentDir: string; trusted: boolean; skillNames: readonly string[] }): AgentSnapshot {
	return buildAgentSnapshot(captureAgentSources(options), options.skillNames);
}
