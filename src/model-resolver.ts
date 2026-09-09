import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionConfig } from "./config.ts";
import { escapeXml, oneLine } from "./text.ts";

export type ModelSettings = { model: Model<any>; thinkingLevel?: ModelThinkingLevel };

type ModelContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

export class ModelClassConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelClassConfigurationError";
	}
}

export class ModelNotFoundError extends ModelClassConfigurationError {
	constructor(provider: string, model: string, modelClass: string) {
		super(`Model ${provider}/${model} for model class ${JSON.stringify(modelClass)} was not found.`);
		this.name = "ModelNotFoundError";
	}
}

export function resolveModelClass(
	requestedClass: string | undefined,
	config: ExtensionConfig,
	ctx: ModelContext,
	mainModel: ModelSettings | undefined,
): ModelSettings {
	const name = requestedClass?.trim() || "parent";
	const resolving = new Set<string>();
	const resolve = (className: string): ModelSettings => {
		if (resolving.has(className)) throw new ModelClassConfigurationError(`Circular model class reference involving ${JSON.stringify(className)}.`);
		resolving.add(className);
		try {
			if (className === "parent") {
				if (!ctx.model) throw new Error("The parent session has no active model.");
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			}
			if (className === "main") {
				if (!mainModel) throw new Error("The main session has no active model.");
				return mainModel;
			}
			const definition = config.modelClasses[className];
			if (!definition) throw new ModelClassConfigurationError(`Unknown model class ${JSON.stringify(className)}. Configure it in subagent.json.`);
			if ("base" in definition) {
				const base = resolve(definition.base);
				const inheritedThinkingLevel = definition.base === "parent" || definition.base === "main" ? undefined : base.thinkingLevel;
				return { model: base.model, thinkingLevel: definition.thinkingLevel ?? inheritedThinkingLevel };
			}
			if (!("model" in definition)) throw new ModelClassConfigurationError(`Model class ${JSON.stringify(className)} must define a model or a base class.`);
			const provider = definition.provider ?? mainModel?.model.provider ?? ctx.model?.provider;
			if (!provider) throw new Error(`Model class ${JSON.stringify(className)} needs a provider because the root session has no active model.`);
			const model = ctx.modelRegistry.getAll().find((candidate) => candidate.id === definition.model && candidate.provider === provider);
			if (!model) throw new ModelNotFoundError(provider, definition.model, className);
			return { model, thinkingLevel: definition.thinkingLevel };
		} finally {
			resolving.delete(className);
		}
	};
	return resolve(name);
}

export function formatAvailableModelClasses(names: readonly string[], config: ExtensionConfig): string {
	const descriptions = new Map([["parent", "The parent session model (default)"], ["main", "The main session model"]]);
	return [
		"The following model classes are available for the `delegate` tool. Set `modelClass` to one of these names.",
		"<delegate_modelClass_options>",
		names.map((name) => {
			const description = config.modelClasses[name]?.description ?? descriptions.get(name);
			return description ? `- ${escapeXml(JSON.stringify(oneLine(name)))}: ${escapeXml(oneLine(description))}` : `- ${escapeXml(JSON.stringify(oneLine(name)))}`;
		}).join("\n"),
		"</delegate_modelClass_options>",
	].join("\n");
}

export type ModelClassAvailability = {
	names: string[];
	diagnostics: string[];
};

export function getModelClassAvailability(
	config: ExtensionConfig,
	ctx: ModelContext,
	mainModel: ModelSettings | undefined,
): ModelClassAvailability {
	const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
	const names = [...(ctx.model ? ["parent"] : []), ...(rootModel ? ["main"] : [])];
	const diagnostics = new Set<string>();
	for (const name of Object.keys(config.modelClasses).sort()) if (name !== "parent" && name !== "main") try {
		resolveModelClass(name, config, ctx, rootModel);
		names.push(name);
	} catch (error) {
		if (error instanceof ModelClassConfigurationError) diagnostics.add(error.message);
	}
	return { names, diagnostics: [...diagnostics] };
}

export function getAvailableModelClassNames(config: ExtensionConfig, ctx: ModelContext, mainModel: ModelSettings | undefined): string[] {
	return getModelClassAvailability(config, ctx, mainModel).names;
}
