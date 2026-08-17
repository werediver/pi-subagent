import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	CONFIG_DIR_NAME,
	parseFrontmatter,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

type ModelClassDefinition =
	| {
		model: string;
		provider?: string;
		thinkingLevel?: ModelThinkingLevel;
		description?: string;
	}
	| {
		base: string;
		thinkingLevel?: ModelThinkingLevel;
		description?: string;
	}
	| {
		description: string;
	};

type ExtensionConfig = {
	modelClasses: Record<string, ModelClassDefinition>;
};

type ModelSettings = {
	model: Model<any>;
	thinkingLevel?: ModelThinkingLevel;
};

const extensionSourcePath = fileURLToPath(import.meta.url);

const DelegateCmdParams = Type.Object({
	task: Type.String({ description: "The task to delegate" }),
	skills: Type.Optional(Type.Array(Type.String(), {
		description:
			"Names of the skills advised for executing the task; these skills will be pre-loaded into the subagent context"
	})),
	modelClass: Type.Optional(Type.String({
		description: "Model class to use for the subagent; defaults to parent",
	})),
});

export type DelegateCmdParams = Static<typeof DelegateCmdParams>;

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read extension configuration at ${path}: ${message}`);
	}
}

function parseExtensionConfig(value: unknown, path: string): ExtensionConfig {
	function isRecord(value: unknown): value is Record<string, unknown> {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}

	function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
		return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
	}

	if (value === undefined) return { modelClasses: {} };
	if (!isRecord(value)) {
		throw new Error(`Extension configuration at ${path} must be a JSON object.`);
	}

	const rawModelClasses = value.modelClasses;
	if (rawModelClasses === undefined) return { modelClasses: {} };
	if (!isRecord(rawModelClasses)) {
		throw new Error(`The modelClasses property in ${path} must be a JSON object.`);
	}

	const modelClasses: Record<string, ModelClassDefinition> = {};
	for (const [name, rawClass] of Object.entries(rawModelClasses)) {
		if (!isRecord(rawClass)) {
			throw new Error(`Model class ${JSON.stringify(name)} in ${path} must be an object.`);
		}

		let base: string | undefined;
		let model: string | undefined;
		let provider: string | undefined;
		let thinkingLevel: ModelThinkingLevel | undefined;
		let description: string | undefined;
		if ("base" in rawClass) {
			if (typeof rawClass.base !== "string" || rawClass.base.trim() === "") {
				throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid base.`);
			}
			base = rawClass.base;
		}
		if ("model" in rawClass) {
			if (typeof rawClass.model !== "string" || rawClass.model.trim() === "") {
				throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid model.`);
			}
			model = rawClass.model;
		}
		if ("provider" in rawClass) {
			if (typeof rawClass.provider !== "string" || rawClass.provider.trim() === "") {
				throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid provider.`);
			}
			provider = rawClass.provider;
		}
		if ("thinkingLevel" in rawClass) {
			if (!isModelThinkingLevel(rawClass.thinkingLevel)) {
				throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid thinkingLevel.`);
			}
			thinkingLevel = rawClass.thinkingLevel;
		}
		if ("description" in rawClass) {
			if (typeof rawClass.description !== "string" || rawClass.description.trim() === "") {
				throw new Error(`Model class ${JSON.stringify(name)} in ${path} has an invalid description.`);
			}
			description = rawClass.description;
		}
		const isBuiltIn = name === "parent" || name === "main";
		if (isBuiltIn) {
			if (model !== undefined || base !== undefined || provider !== undefined || thinkingLevel !== undefined) {
				throw new Error(`Built-in model class ${JSON.stringify(name)} in ${path} may only specify a description.`);
			}
			if (description === undefined) {
				throw new Error(`Built-in model class ${JSON.stringify(name)} in ${path} must specify a description.`);
			}
			modelClasses[name] = { description };
			continue;
		}
		if (model !== undefined && base !== undefined) {
			throw new Error(`Model class ${JSON.stringify(name)} in ${path} cannot specify both model and base.`);
		}
		if (model === undefined && base === undefined) {
			throw new Error(`Model class ${JSON.stringify(name)} in ${path} must define either a model or a base class.`);
		}
		if (base !== undefined) {
			if (provider !== undefined) {
				throw new Error(`Model class ${JSON.stringify(name)} in ${path} cannot specify a provider when using a base class.`);
			}
			modelClasses[name] = {
				base,
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				...(description === undefined ? {} : { description }),
			};
		} else {
			modelClasses[name] = {
				model: model!,
				...(provider === undefined ? {} : { provider }),
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				...(description === undefined ? {} : { description }),
			};
		}
	}

	return { modelClasses };
}

function loadExtensionConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExtensionConfig {
	const globalPath = join(getAgentDir(), "subagent.json");
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "subagent.json");
	const globalConfig = parseExtensionConfig(readJsonFile(globalPath), globalPath);
	const projectConfig =
		parseExtensionConfig(ctx.isProjectTrusted() ? readJsonFile(projectPath) : undefined, projectPath);
	return {
		modelClasses: {
			...globalConfig.modelClasses,
			...projectConfig.modelClasses,
		},
	};
}

function resolveModelClass(
	requestedClass: string | undefined,
	config: ExtensionConfig,
	ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">,
	mainModel: ModelSettings | undefined,
): ModelSettings {
	const className = requestedClass?.trim() || "parent";
	const availableModels = ctx.modelRegistry.getAll();
	const modelClasses = config.modelClasses;
	const resolving = new Set<string>();

	const resolve = (name: string): ModelSettings => {
		if (resolving.has(name)) throw new Error(`Circular model class reference involving ${JSON.stringify(name)}.`);
		resolving.add(name);
		try {
			if (name === "parent") {
				if (!ctx.model) throw new Error("The parent session has no active model.");
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			}
			if (name === "main") {
				if (!mainModel) throw new Error("The main session has no active model.");
				return mainModel;
			}
			const classConfig = modelClasses[name];
			if (!classConfig) {
				throw new Error(`Unknown model class ${JSON.stringify(name)}. Configure it in subagent.json.`);
			}
			if ("base" in classConfig) {
				const base = resolve(classConfig.base);
				return {
					model: base.model,
					thinkingLevel: classConfig.thinkingLevel ?? base.thinkingLevel,
				};
			}

			if (!("model" in classConfig)) {
				throw new Error(`Model class ${JSON.stringify(name)} must define a model or a base class.`);
			}

			const provider = classConfig.provider ?? mainModel?.model.provider;
			if (!provider) {
				throw new Error(`Model class ${JSON.stringify(name)} needs a provider because the main session has no active model.`);
			}
			const model = availableModels.find((model) => model.id === classConfig.model && model.provider === provider);
			if (!model) {
				const qualifiedModel = `${provider}/${classConfig.model}`;
				throw new Error(`Model ${JSON.stringify(qualifiedModel)} for model class ${JSON.stringify(name)} was not found.`);
			}
			return {
				model,
				thinkingLevel: classConfig.thinkingLevel ?? ctx.thinkingLevel,
			};
		} finally {
			resolving.delete(name);
		}
	};

	return resolve(className);
}

type DelegateCmdResult = {
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

function getAvailableModelClassNames(
	config: ExtensionConfig,
	ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">,
	mainModel: ModelSettings | undefined,
): string[] {
	const names: string[] = [];
	const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);

	if (ctx.model) names.push("parent");
	if (rootModel) names.push("main");

	for (const name of Object.keys(config.modelClasses).sort()) {
		if (name === "parent" || name === "main") continue;
		try {
			resolveModelClass(name, config, ctx, rootModel);
			names.push(name);
		} catch {
			// Do not advertise classes whose configured model is unavailable.
		}
	}

	return names;
}

function formatAvailableModelClasses(names: readonly string[], config: ExtensionConfig): string {
	const descriptions = new Map([
		["parent", "The parent session model (default)"],
		["main", "The main session model"],
	]);
	const entries = names.map((name) => {
		const description = config.modelClasses[name]?.description ?? descriptions.get(name);
		return description
			? `- ${JSON.stringify(name)}: ${description}`
			: `- ${JSON.stringify(name)}`;
	});

	return [
		"The following model classes are available for the `delegate` tool. Set `modelClass` to one of these names.",
		"<delegate_modelClass_options>",
		entries.join("\n"),
		"</delegate_modelClass_options>",
	].join("\n");
}

function resolvePreloadedSkills(availableSkills: readonly Skill[], requestedNames?: readonly string[]): Skill[] {
	if (!requestedNames || requestedNames.length === 0) return [];

	const skillsByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
	const uniqueNames = [...new Set(requestedNames)];
	const missingNames = uniqueNames.filter((name) => !skillsByName.has(name));
	if (missingNames.length > 0) {
		const availableNames = availableSkills.map((skill) => skill.name);
		const suffix = availableNames.length > 0 ? ` Available skills: ${availableNames.join(", ")}.` : "";
		throw new Error(`Unknown skill${missingNames.length === 1 ? "" : "s"}: ${missingNames.join(", ")}.${suffix}`);
	}

	return uniqueNames.map((name) => skillsByName.get(name)!);
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatPreloadedSkills(skills: readonly Skill[]): string {
	const blocks = skills.map((skill) => {
		const body = parseFrontmatter(readFileSync(skill.filePath, "utf-8")).body;
		return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	});

	return [
		"The following skills were explicitly pre-loaded for this task. Respect them when carrying out the task.",
		"<preloaded_skills>",
		blocks.join("\n\n"),
		"</preloaded_skills>",
	].join("\n");
}

function createExtensionFactory(mainModel: ModelSettings | undefined): (pi: ExtensionAPI) => void {
	return (pi) => registerExtension(pi, mainModel);
}

function registerExtension(pi: ExtensionAPI, mainModel: ModelSettings | undefined) {
	pi.on("before_agent_start", (event, ctx) => {
		try {
			const config = loadExtensionConfig(ctx);
			const names = getAvailableModelClassNames(config, ctx, mainModel);
			return {
				systemPrompt: `${event.systemPrompt}\n\n${formatAvailableModelClasses(names, config)}`,
			};
		} catch {
			// Configuration and model-resolution errors are reported when delegation is attempted.
			return undefined;
		}
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "Delegate a task to a subagent with a separate context window and return its final message.",
		parameters: DelegateCmdParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const abortSignal = signal ?? new AbortController().signal;
			const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
			let resolvedModel: ModelSettings;
			try {
				const config = loadExtensionConfig(ctx);
				resolvedModel = resolveModelClass(params.modelClass, config, ctx, rootModel);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const result: DelegateCmdResult = { status: "failed", error: message };
				return {
					content: [{ type: "text", text: message }],
					details: result,
					isError: true,
				};
			}
			let preloadedSkills: Skill[] = [];
			const resourceLoader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				extensionsOverride: (current) => ({
					...current,
					extensions: current.extensions.filter(
						(extension) =>
							extension.path !== extensionSourcePath && extension.resolvedPath !== extensionSourcePath,
					),
				}),
				extensionFactories: [createExtensionFactory(rootModel)],
				noPromptTemplates: true,
				noThemes: true,
				skillsOverride: (current) => {
					preloadedSkills = resolvePreloadedSkills(current.skills, params.skills);
					return current;
				},
				appendSystemPromptOverride: (current) =>
					preloadedSkills.length > 0 ? [...current, formatPreloadedSkills(preloadedSkills)] : current,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				model: resolvedModel.model,
				thinkingLevel: resolvedModel.thinkingLevel,
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

export default function (pi: ExtensionAPI) {
	registerExtension(pi, undefined);
}
