import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentDefinition, AgentSnapshot } from "./agent-definitions.ts";
import { escapeXml, oneLine } from "./text.ts";

export type ModelSettings = { model: Model<any>; thinkingLevel?: ModelThinkingLevel };

type ModelContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

export class AgentModelNotFoundError extends Error {
	constructor(provider: string, model: string, agent: string) {
		super(`Model ${provider}/${model} for agent ${JSON.stringify(agent)} was not found in the model registry. Register the model or set the agent's provider.`);
		this.name = "AgentModelNotFoundError";
	}
}

/**
 * Resolve an agent's concrete model ID against the live root model context.
 * An omitted model inherits the immediate caller's model and thinking level.
 * Concrete model IDs use their explicit provider, or the current root provider
 * when no provider is specified.
 */
export function resolveAgentModel(
	definition: AgentDefinition,
	ctx: ModelContext,
	rootModel: ModelSettings | undefined,
	rootRegistry: ModelContext["modelRegistry"] = ctx.modelRegistry,
): ModelSettings {
	let resolved: ModelSettings;
	if (definition.model === undefined) {
		if (!ctx.model) throw new Error("The parent session has no active model.");
		resolved = { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
	} else {
		resolved = resolveConcreteAgentModel(definition, rootModel, rootRegistry);
	}
	return definition.thinkingLevel === undefined ? resolved : { model: resolved.model, thinkingLevel: definition.thinkingLevel };
}

function resolveConcreteAgentModel(
	definition: AgentDefinition,
	rootModel: ModelSettings | undefined,
	rootRegistry: ModelContext["modelRegistry"],
): ModelSettings {
	const model = definition.model;
	if (!model) throw new Error(`Agent ${JSON.stringify(definition.name)} does not reference a concrete model ID.`);
	const provider = model.provider ?? rootModel?.model.provider;
	if (!provider) throw new Error(`Agent ${JSON.stringify(definition.name)} needs a provider because the root session has no active model.`);
	const found = rootRegistry.getAll().find((candidate) => candidate.id === model.name && candidate.provider === provider);
	if (!found) throw new AgentModelNotFoundError(provider, model.name, definition.name);
	return { model: found };
}

/** Return currently resolvable definitions in snapshot discovery order without changing the snapshot. */
export function getAgentAvailability(
	snapshot: AgentSnapshot,
	ctx: ModelContext,
	rootModel: ModelSettings | undefined,
	rootRegistry: ModelContext["modelRegistry"] = ctx.modelRegistry,
): AgentDefinition[] {
	return snapshot.definitions.filter((definition) => {
		try {
			resolveAgentModel(definition, ctx, rootModel, rootRegistry);
			return true;
		} catch {
			return false;
		}
	});
}

/** Format only agent names and optional descriptions for the delegation prompt. */
export function formatAgentDigest(definitions: readonly AgentDefinition[]): string {
	return [
		"The following agents are available for the `delegate` tool. Set `agent` to one of these names.",
		"<delegate_agent_options>",
		definitions.map(({ name, description }) => description
			? `- ${escapeXml(JSON.stringify(oneLine(name)))}: ${escapeXml(oneLine(description))}`
			: `- ${escapeXml(JSON.stringify(oneLine(name)))}`).join("\n"),
		"</delegate_agent_options>",
	].join("\n");
}
