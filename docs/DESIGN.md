# Role-free subagents

## Purpose

This extension lets a main agent delegate work to independent subagents. It is designed around skills rather than roles: roles add little when the caller can explicitly provide the capabilities a subagent needs, while skills remain reusable across different tasks.

The extension is responsible for invoking subagents, selecting their models, and returning their results. A subagent is an independent agent, not an implicit continuation of the main agent's context.

## Invocation

The invocation contract is:

```ts
type SubagentRequest = {
  title: string;
  input: string;
  skills?: string[];
  agentPreset?: string;
};
```

The main agent must include relevant context in `input`; the subagent does not share the main agent's conversation context. `skills` supplies the capabilities needed for the task, and `agentPreset` expresses model intent without requiring the caller to know concrete provider or model names.

The initial result contract is:

```ts
type SubagentResult = {
  status: "completed" | "failed" | "cancelled";
  text?: string;
  error?: string;
};
```

Results are returned as labeled tool output. They must not be silently inserted into the main agent's context as an unlabeled user message.

Independent invocations may run concurrently. Dependent work is staged: the main agent passes an earlier result into the input of a later subagent invocation. Subagents may invoke the extension themselves, so delegation can be nested.

## Agent presets

An agent preset is a deployment-facing abstraction for model selection. The caller expresses intent; the extension resolves that intent to concrete provider and model settings. This preserves control over model choice, cost, and latency in configuration rather than scattering provider-specific names through callers and skills.

The built-in agent presets have stable ancestry semantics:

- `parent` uses the immediate caller's model.
- `main` uses the top-level main agent's model, even through nested delegation.

Other agent presets can specify a concrete model, provider, and thinking level, or derive from another agent preset with `base`. Global configuration provides defaults, while project-level configuration may add agent presets or replace configured agent presets.

```json
{
  "agentPresets": {
    "parent": {
      "description": "Use the calling agent's model"
    },
    "main": {
      "description": "Use the top-level main agent's model"
    },
    "lightweight": {
      "model": "lightweight-model",
      "thinkingLevel": "low",
      "description": "Optimized for latency and cost"
    },
    "alternative": {
      "model": "independent-review-model",
      "provider": "provider",
      "description": "A meaningfully different perspective"
    },
    "alternative-lightweight": {
      "base": "alternative",
      "thinkingLevel": "low",
      "description": "A lightweight independent review"
    }
  }
}
```

The descriptions of the built-in `parent` and `main` agent presets may be overridden for local presentation, but their resolution semantics remain fixed. Agent-preset configuration is owned by the implementation, allowing deployments to change mappings without changing callers, skills, or the invocation contract.

Configuration may also define an optional top-level `subagentPreamble` string. When the extension is registered in a child session for nested delegation, this text is appended to the end of that child session's system prompt.
