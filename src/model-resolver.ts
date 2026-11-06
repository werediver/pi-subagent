import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentDefinition, AgentSnapshot } from "./agent-definitions.ts";
import { escapeXml, oneLine } from "./text.ts";

export type ModelSettings = { model: Model<any>; thinkingLevel?: ModelThinkingLevel };

type ModelContext = Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">;

export class AgentModelNotFoundError extends Error {
	constructor(attempted: readonly { readonly provider?: string; readonly id: string }[], agent: string) {
		const pairs = attempted.map(({ provider, id }) => `${JSON.stringify(provider ?? "<no root provider>")}/${JSON.stringify(id)}`).join(", ");
		super(`None of the model candidates for agent ${JSON.stringify(agent)} were found in the live model registry. Attempted: ${pairs}. Register the models or update the agent's model candidates.`);
		this.name = "AgentModelNotFoundError";
	}
}

/**
 * Resolve an agent's concrete model ID against the live root model context.
 * An omitted model inherits the immediate caller's model and thinking level.
 * Concrete candidates use their explicit provider, or the current root provider
 * when no provider is specified, and are tried in order.
 */
export function resolveAgentModel(
	definition: AgentDefinition,
	ctx: ModelContext,
	rootModel: ModelSettings | undefined,
	rootRegistry: ModelContext["modelRegistry"] = ctx.modelRegistry,
): ModelSettings {
	if (definition.model === undefined) {
		if (!ctx.model) throw new Error("The parent session has no active model.");
		return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
	}
	return resolveConcreteAgentModel(definition, rootModel, rootRegistry);
}

function resolveConcreteAgentModel(
	definition: AgentDefinition,
	rootModel: ModelSettings | undefined,
	rootRegistry: ModelContext["modelRegistry"],
): ModelSettings {
	const candidates = definition.model;
	if (!candidates?.length) throw new Error(`Agent ${JSON.stringify(definition.name)} does not reference a concrete model candidate.`);
	const models = rootRegistry.getAll();
	const attempted: { provider?: string; id: string }[] = [];
	for (const candidate of candidates) {
		const provider = candidate.provider ?? rootModel?.model.provider;
		attempted.push({ ...(provider === undefined ? {} : { provider }), id: candidate.id });
		if (provider === undefined) continue;
		const found = models.find((model) => model.id === candidate.id && model.provider === provider);
		if (found) return { model: found, ...(candidate.thinkingLevel === undefined ? {} : { thinkingLevel: candidate.thinkingLevel }) };
	}
	throw new AgentModelNotFoundError(attempted, definition.name);
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
