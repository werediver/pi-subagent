import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionConfig } from "./config.ts";
import { escapeXml, oneLine } from "./text.ts";

export type ModelSettings = { model: Model<any>; thinkingLevel?: ModelThinkingLevel };

type ModelContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

export class AgentPresetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentPresetError";
	}
}

export class ModelNotFoundError extends AgentPresetError {
	constructor(provider: string, model: string, agentPreset: string) {
		super(`Model ${provider}/${model} for agent preset ${JSON.stringify(agentPreset)} was not found.`);
		this.name = "ModelNotFoundError";
	}
}

export function resolveAgentPreset(
	requestedPreset: string | undefined,
	config: ExtensionConfig,
	ctx: ModelContext,
	mainModel: ModelSettings | undefined,
): ModelSettings {
	const name = requestedPreset?.trim() || "parent";
	const resolving = new Set<string>();
	const resolve = (presetName: string): ModelSettings => {
		if (resolving.has(presetName)) throw new AgentPresetError(`Circular agent preset reference involving ${JSON.stringify(presetName)}.`);
		resolving.add(presetName);
		try {
			if (presetName === "parent") {
				if (!ctx.model) throw new Error("The parent session has no active model.");
				return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
			}
			if (presetName === "main") {
				if (!mainModel) throw new Error("The main session has no active model.");
				return mainModel;
			}
			const definition = config.agentPresets[presetName];
			if (!definition) throw new AgentPresetError(`Unknown agent preset ${JSON.stringify(presetName)}. Configure it in subagent.json.`);
			if ("base" in definition) {
				const base = resolve(definition.base);
				const inheritedThinkingLevel = definition.base === "parent" || definition.base === "main" ? undefined : base.thinkingLevel;
				return { model: base.model, thinkingLevel: definition.thinkingLevel ?? inheritedThinkingLevel };
			}
			if (!("model" in definition)) throw new AgentPresetError(`Agent preset ${JSON.stringify(presetName)} must define a model or a base preset.`);
			const provider = definition.provider ?? mainModel?.model.provider ?? ctx.model?.provider;
			if (!provider) throw new Error(`Agent preset ${JSON.stringify(presetName)} needs a provider because the root session has no active model.`);
			const model = ctx.modelRegistry.getAll().find((candidate) => candidate.id === definition.model && candidate.provider === provider);
			if (!model) throw new ModelNotFoundError(provider, definition.model, presetName);
			return { model, thinkingLevel: definition.thinkingLevel };
		} finally {
			resolving.delete(presetName);
		}
	};
	return resolve(name);
}

export function formatAvailableAgentPresets(names: readonly string[], config: ExtensionConfig): string {
	const descriptions = new Map([["parent", "The parent session model (default)"], ["main", "The main session model"]]);
	return [
		"The following agent presets are available for the `delegate` tool. Set `agentPreset` to one of these names.",
		"<delegate_agentPreset_options>",
		names.map((name) => {
			const description = config.agentPresets[name]?.description ?? descriptions.get(name);
			return description ? `- ${escapeXml(JSON.stringify(oneLine(name)))}: ${escapeXml(oneLine(description))}` : `- ${escapeXml(JSON.stringify(oneLine(name)))}`;
		}).join("\n"),
		"</delegate_agentPreset_options>",
	].join("\n");
}

export type AgentPresetAvailability = {
	names: string[];
	diagnostics: string[];
};

export function getAgentPresetAvailability(
	config: ExtensionConfig,
	ctx: ModelContext,
	mainModel: ModelSettings | undefined,
): AgentPresetAvailability {
	const rootModel = mainModel ?? (ctx.model ? { model: ctx.model, thinkingLevel: ctx.thinkingLevel } : undefined);
	const names = [...(ctx.model ? ["parent"] : []), ...(rootModel ? ["main"] : [])];
	const diagnostics = new Set<string>();
	for (const name of Object.keys(config.agentPresets).sort()) if (name !== "parent" && name !== "main") try {
		resolveAgentPreset(name, config, ctx, rootModel);
		names.push(name);
	} catch (error) {
		if (error instanceof AgentPresetError) diagnostics.add(error.message);
	}
	return { names, diagnostics: [...diagnostics] };
}

export function getAvailableAgentPresetNames(config: ExtensionConfig, ctx: ModelContext, mainModel: ModelSettings | undefined): string[] {
	return getAgentPresetAvailability(config, ctx, mainModel).names;
}
