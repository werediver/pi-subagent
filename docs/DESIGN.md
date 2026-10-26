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
      "description": "A meaningfully different perspective",
      "tools": { "*": false, "read": true, "exa_*": true }
    },
    "alternative-lightweight": {
      "base": "alternative",
      "thinkingLevel": "low",
      "description": "A lightweight independent review"
    }
  }
}
```

The descriptions of the built-in `parent` and `main` agent presets may be overridden for local presentation, but their resolution semantics remain fixed. An agent preset's `description` may be a string or an array of strings joined with newlines. Agent-preset configuration is owned by the implementation, allowing deployments to change mappings without changing callers, skills, or the invocation contract.

An agent preset may also declare a `tools` mapping from glob patterns to booleans. Patterns only support `*`, which matches any run of characters including none, and are matched against the whole tool name case-sensitively. Every tool starts enabled; matching rules are applied in declaration order, so the last matching rule wins, and a tool matched by no rule stays enabled. Omitted `tools` means no restriction. The built-in `parent` and `main` presets do not accept `tools` because the extension must not restrict the session it registers into.

A preset that derives from a `base` inherits the base's tool rules first, so the derived preset's own rules layer on top under last-match-wins evaluation. Tool access is resolved when an opening delegation creates the child session and is fixed for that session's lifetime; continuations reuse the child's existing tool set.

## Subordination awareness

A session's position in the delegation hierarchy is its `subordinationLevel`: the top-level session is `0`, and each opening delegation creates a child at `caller + 1`. Because the extension registers itself in child sessions for nested delegation, it can recognize a subordinate session and make the subagent aware of the fact of its delegation. The level itself is internal bookkeeping: a subagent reports only to its immediate parent and behaves identically at every level, so the exact level is not communicated.

Every child session's system prompt receives a built-in `delegation_context` section. It is the forward-path counterpart of the `delegate_result` envelope: the parent labels what it returns, so the child is labelled with what it received. Subordination belongs to the session while the delegated work belongs to each request: the session is subordinate for its whole lifetime, every request in it is delegated work, and each request's result returns to the caller. It states that a delegated request must be carried out directly rather than re-delegated — including when a loaded skill or instruction prescribes delegation, since such instructions assume the authority of the top-level caller, which a subagent does not have — while delegating a genuinely independent subtask remains permitted. Because a child session can be continued, the context also directs the subagent to treat earlier work in the conversation as context to build on rather than as a finished deliverable.

## Subagent preamble

Configuration may also define an optional top-level `subagentPreamble` string or array of strings. When the extension is registered in a child session for nested delegation, this text is appended to the end of that child session's system prompt, after the built-in `delegation_context`. Array entries are joined with newlines.
