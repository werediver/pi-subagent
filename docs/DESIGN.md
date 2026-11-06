# Delegation

## Purpose

This extension lets an agent delegate work to independent subagents. The caller selects a predefined agent and supplies a task; the agent definition supplies the prompt and runtime configuration. This keeps capabilities and model selection with the agent rather than assembling them at each call site.

The extension creates child sessions and returns their results. A new child does not implicitly share the caller's conversation context. See [Agent definitions](./DESIGN_DEF.md) for discovery, configuration, model selection, skills, and the available-agent digest.

## Invocation

An opening delegation names an `agent` and supplies a non-empty `title` and `input`. The caller must include relevant context in `input`. A continuation supplies a previously returned session ID instead of an agent and builds on the existing child conversation. See the [invocation contract](./DESIGN_DEF.md#invocation) and [child session reuse](./DESIGN_REUSE.md).

Results are returned as labeled tool output, not as unlabeled user messages. The [result contract](./DESIGN_REUSE.md#results) defines statuses, session IDs, and the caller-facing envelope.

Independent child sessions may run concurrently. Dependent work can be staged by passing an earlier result into a later invocation, or by continuing the same child. Subagents may delegate independent subtasks when their agent's tool rules leave `delegate` active, so delegation can be nested.

## Configuration boundary

Agent definitions own child tool access, skills policy, and model selection. An explicit model specifies one or more ordered concrete candidates; the first exact provider/ID match in the live root registry is selected when building the digest or opening a child. The selected candidate's optional thinking level applies; otherwise the child uses its default. An omitted model inherits the immediate caller's model and thinking level unchanged, with no top-level override. A registry match does not guarantee runtime, authentication, or request success, and those failures do not trigger fallback. The selected definition and model remain bound to the child across continuations.
