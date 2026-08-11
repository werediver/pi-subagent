# Subagents in Pi

## Overview

A subagent is an ordinary Pi `AgentSession` running under a role skill. The
`subagent` tool creates or resumes that session and returns its result to the
calling agent.

Skills are the only instruction/resource concept in this design:

```text
subagents       general guidance for using subagents
researcher-role specialist role skill
reviewer-role   specialist role skill
```

There is no separate role resource, agent-definition type, or special session
class.

## Goals

- Let an agent delegate focused work to an independent subagent.
- Return a useful result to the calling agent.
- Support enriched role sessions that can be resumed later.
- Keep role behavior predictable through explicit role-skill loading.
- Keep the session lifecycle simple: one session per role and working directory.
- Reuse Pi's existing skills, sessions, SDK, extensions, and session format.
- Enforce operational constraints such as tools, timeouts, cancellation, and
  concurrency in the runner.

## Non-goals

- Adding built-in subagent semantics to Pi core.
- Introducing a separate role or agent-definition entity.
- Sharing the parent's complete conversation with a child.
- Merging child conversations into the parent conversation.
- Supporting multiple same-role sessions or session forks in the base design.

## Concepts

### Skills

A skill is a reusable capability, procedure, or set of instructions. Skills are
discovered through Pi's normal skill inventory and may be global, project-local,
or package-provided.

Some skills are role skills by convention: their names end in `-role` and they
define a specialist's identity, responsibilities, constraints, methodology, and
expected result format. Other skills are ordinary capabilities that any agent
may use.

For example:

```text
web-search        ordinary capability skill
evidence-report   ordinary capability skill
researcher-role   specialist role skill
```

### Roles

A role is the specialist identity selected by the `role` argument of the
`subagent` tool. The role name resolves to a skill with the `-role` suffix:

```text
role: researcher
    -> researcher-role
```

The role list is not hardcoded. Roles should be discovered through Pi's
normal skill inventory wherever possible, using the `-role` suffix and skill
descriptions. An invocation for an unknown role should produce a clear error
rather than silently creating an unconfigured session.

### `subagents` skill

`subagents` is an ordinary skill that explains when and how to use subagents.
An agent—whether the main session or a subagent—may load it when delegation
could help its current task. It can explain role discovery, task formulation,
session modes, result handling, and how to integrate reports, but it does not
need to contain an exhaustive role catalog.

The tool is always registered; its availability is not coupled to whether the
`subagents` skill has been loaded. The skill provides guidance, while the tool
provides the capability.

## Role skills and child context

When a subagent is created, the runner deterministically loads the resolved
role skill into its context. This gives role behavior strong semantics without
requiring a new runtime type. The child may still discover and use ordinary
skills normally.

The child does not receive the parent's entire conversation. Its context is
constructed from:

1. the resolved role skill;
2. a short subagent envelope;
3. the task;
4. the expected result contract.

Conceptually:

```text
[Role contract]
You are operating as the `researcher` role.
<researcher-role skill content>

[Subagent envelope]
Work independently. Your final response is returned to the calling agent.
Do not claim work you did not perform. Do not delegate further unless allowed.

[Task]
Investigate how session persistence works.

[Result contract]
Return a self-contained report with summary, findings, evidence, and open
questions.
```

A role skill may be stored using Pi's normal skill layout:

```text
~/.pi/agent/skills/researcher-role/SKILL.md
```

Example:

```markdown
---
name: researcher-role
description: Read-only repository investigation and evidence-based reporting.
---

# Researcher

Investigate the assigned question using source code and documentation. Do not
modify files. Distinguish facts, inferences, and open questions. Cite paths and
line ranges. Return a concise, self-contained report.
```

## `subagent` tool

The parent-facing operation is a custom tool named `subagent`. Its
implementation-facing types use `Subagent*` names:

```ts
type SubagentRequest = {
  role: string;
  task: string;
  mode?: "reuse" | "fresh";
  timeoutMs?: number;
  tools?: string[];
};
```

Example:

```ts
subagent({
  role: "researcher",
  task: "Investigate how session persistence works in this repository.",
});
```

The tool may accept either a base role name such as `researcher` or the full
skill name `researcher-role`. Pi should discover the corresponding skill
through its normal skill inventory. In practice, role skills are identified by
the `-role` suffix. The child inherits the parent's working directory; an
explicit child cwd is not part of the base request.

The runner owns execution mechanics: role resolution, session lookup, locking,
child creation, prompting, result collection, cancellation, and persistence.
A request-level `tools` restriction may only narrow the role's allowed tools;
it cannot expand permissions or bypass Pi project trust. Tool names use Pi's
normal registered tool names.

## Session lifecycle

There is at most one subagent session for each resolved role and working
directory. This deliberately avoids choosing among several same-role sessions.
Pi has no separate project concept needed for this design; the working
directory is the session context.

The session identity is:

```text
cwd + resolved role skill
```

User-provided scope is omitted from the base design.

### `reuse`

`reuse` is the default. Continue the existing session for the role and cwd, or
create it if none exists. This is the normal way to continue an enriched
specialist across requests and process restarts.

### `fresh`

Replace the existing session for the role and cwd, then create a new session
with the role skill and task. If the existing session is busy, `fresh` waits for
its single-writer lock rather than interrupting an in-flight prompt. The old
transcript may remain in Pi's ordinary session storage for diagnostics, but the
registry points only to the replacement session. Fresh sessions do not
accumulate in an active pool. There is no `fork` mode in the base design.

## Persistence and concurrency

Persistent role sessions use Pi's existing `SessionManager` and JSONL session
files in Pi's ordinary session directory. A small registry may record:

```json
{
  "role": "researcher",
  "skill": "researcher-role",
  "sessionFile": "...",
  "sessionId": "...",
  "lastUsedAt": "..."
}
```

Role-skill changes require no special provisioning or migration mechanism. Pi
can reload configuration and reinitialize extensions through its normal
lifecycle. A reused session must verify that its resolved role skill is still
available; if the skill content or identity changed, the runner should create a
new session rather than continue with a stale role contract. A role version or
content fingerprint may be recorded for diagnostics.

When recovering extension state after resuming a parent session, the runner
must resolve each persisted role through Pi's current skill inventory. If a
role skill no longer resolves—for example after a configuration reload or
harness restart—the associated subagent session is left unused and ignored.
It must not be invoked with a missing or stale role contract. The persisted
entry may remain available for diagnostics or later recovery if the skill
becomes available again.

A role session is a single-writer resource. Concurrent requests for the same
`(cwd, role)` session must not interleave prompts. The initial implementation
should serialize them; the user-visible behavior while waiting remains open.

Concurrency across independent subagent invocations is controlled by the
extension runner rather than by a special batch mode. An optional semaphore-
based concurrency control is a possible development: when enabled, one
semaphore shared by the extension instance can limit the number of child
prompts actively executing in that Pi process. Requests beyond the limit would
wait for a slot and must remain cancellable while waiting. A slot would cover
the child prompt through result collection; waiting for a per-session lock would
not consume a slot. The base design does not require this global semaphore;
the per-session single-writer lock remains the required concurrency control.

When enabled, the semaphore does not make execution parallel by itself. The
parent agent must issue independent `subagent` calls separately, and the Pi
host must dispatch those calls concurrently. If the host dispatches them
serially, they remain serial regardless of the semaphore. Calls resolving to
the same `(cwd, role)` session still serialize behind that session's
single-writer lock.

### Extension state recovery

The extension's in-memory registry is a cache, not the source of truth. When a
subagent session is activated, the extension should persist the relationship
between the parent session and the child session in the parent session's
custom entries. The child transcript remains an ordinary Pi session.

On initialization or parent-session resume, the extension replays those entries
to reconstruct the `(cwd, role)` mapping. It recreates runtime-only state such
as locks, active session objects, timers, and event subscriptions; these are
not persisted. Recovered sessions are initially idle and may be opened lazily.

A recovered relationship is usable only when its role still resolves through
Pi's current skill inventory. If the role skill is unavailable after a harness
restart or configuration reload, the session is left unused and ignored rather
than invoked without its role contract. The persisted relationship may remain
available for diagnostics or later recovery if the skill returns. If multiple
parent sessions reference the same `(cwd, role)` child, they share its
single-writer lock and registry entry rather than creating competing children.

## Strong semantics and runtime enforcement

The role skill defines behavioral semantics: purpose, methodology, constraints,
and result shape. The runner enforces operational properties that the model
cannot reliably enforce:

- tool allowlists and read-only versus write-capable execution;
- working directory;
- model and thinking level;
- timeout and cancellation;
- maximum nesting depth;
- persistence and concurrency;
- result limits and validation.

For example, a researcher role should receive only read-oriented tools where
possible. The instruction not to edit files is useful, but removing `write`
and `edit` is the actual safety boundary.

Role-provided tool policies cannot bypass Pi's project-trust behavior. Normal
Pi trust handling takes precedence automatically; no additional provisioning
is required.

## Results

The child result is returned as the `subagent` tool result. It is not silently
inserted into the parent conversation as an unlabeled user message. Child
identity, task IDs, usage, and other execution details are registry or
observability metadata, not part of the minimal result contract.

The initial result should be deliberately minimal:

```ts
type SubagentResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  text?: string;
  error?: string;
};
```

`text` is the child's final assistant response. Role skills should request a
self-contained report when that is useful. Session identity, task IDs, usage,
and other execution details are metadata for the registry or observability,
not part of the core result.

The first implementation may collect final assistant text from session
messages or events. Structured output is deliberately deferred: it should only
be introduced later if a concrete use case requires machine-readable results,
and then with an explicit schema or protocol rather than an unconstrained
`unknown` field.

## Lifecycle and cancellation

The subagent runner should:

1. resolve the role skill through Pi's skill inventory;
2. resolve the `(cwd, role)` session;
3. acquire its lock;
4. create, open, or replace the child `AgentSession`;
5. prompt it with the role skill, envelope, and task;
6. collect and validate the result;
7. release the lock;
8. return a normalized `SubagentResult`.

Cancellation should abort the child. If the optional extension semaphore is
enabled, requests waiting for it or for a per-session lock must be removed or
marked cancelled rather than occupying the queue indefinitely. The runner
should support wall-clock timeouts and distinguish failure, cancellation, and
timeout. A child failure should normally be returned as a failed result rather
than crashing the parent.

Recursive subagent use is disabled by default for role sessions. If enabled,
the runner should enforce a maximum depth.

## `subagent-list`

The extension should provide a `subagent-list` command listing subagent sessions
that have actually been activated through the `subagent` tool. It is an
operational view of the session registry, not a catalog of available roles.

Each entry should include, at minimum:

- role and resolved role skill;
- working directory;
- session ID or session file;
- busy/idle status;
- last-used time;
- whether the current session was created by `reuse` or `fresh`.

Since there is only one session per `(cwd, role)`, the list has no session
selection ambiguity. `reuse` continues the listed session; `fresh` replaces it.
Whether replaced-session history is retained for diagnostics remains open.

## Observability and execution

The `subagent` result remains the minimal status/text/error contract above;
child metadata is kept in the registry or exposed through optional observability
features. Interactive extensions may provide status widgets, lifecycle
notifications, and access to child session transcripts. RPC/JSON integrations
may expose structured start/end events.
Streaming every child token is not the default; the parent generally needs the
report, while optional progress is useful to users.

The preferred initial implementation is same-process SDK usage:

- `createAgentSession()` creates children;
- `SessionManager` handles persistence;
- `AgentSession.prompt()` runs tasks;
- session events provide progress and result collection.

Initial execution is synchronous (awaited): the `subagent` tool waits for the
child prompt to finish and returns its `SubagentResult` in the same tool call.
This keeps the first lifecycle and result contract simple. The separate child
session still provides the foundation for concurrent execution later.

Background execution is a close future target. It would start a child prompt
without holding the parent tool call open, return a durable job identifier, and
report completion through a command, notification, or explicitly injected
parent message. It requires a small job/lifecycle layer for cancellation,
completion state, persistence, recovery, and result retrieval.

Explicit parallel and sequential delegation do not require special batch
semantics in the base design. An agent can request independent work by issuing
multiple `subagent` tool calls in one assistant turn; the host may execute those
calls concurrently; an optional runner semaphore may bound the number of
active child sessions. An agent can request dependent work through successive
tool calls, using each returned result to formulate the next task. The runner does
not infer dependencies, preserve a workflow graph, or automatically pass prior
results; the parent formulates each next task. This naturally supports workflows
such as research → plan → implementation without placeholder-based chain syntax
or a separate orchestration protocol.

A future batch or chain API could still be useful for fixed workflows,
standardized aggregation, or reducing parent turns, but it would add schema,
result aggregation, cancellation, and failure semantics. It is not required for
parallel or sequential delegation and is therefore deferred. Parallel execution
of independent child sessions remains subject to per-session single-writer
serialization and, if the optional control is enabled, the runner's global
concurrency bound.

Subprocess execution through `pi --mode rpc` remains a possible later option
for process isolation or hard termination, but is not required by the model.

## Example layout

```text
~/.pi/agent/skills/
  subagents/
    SKILL.md
  researcher-role/
    SKILL.md
  reviewer-role/
    SKILL.md
  implementer-role/
    SKILL.md
  evidence-report/
    SKILL.md
```

No `.pi/roles/` directory is introduced.

## Implementation plan

### Phase 1: one-shot sessions

- Add the always-registered `subagent` custom tool.
- Resolve `role` to a `*-role` skill.
- Create an in-memory child session.
- Pass the role skill, envelope, and task.
- Return final assistant text.
- Add timeout, cancellation, and basic tool restrictions.
- Optionally add semaphore-based concurrency control for active child sessions;
  this is a possible development rather than a base-design requirement.

### Phase 2: persistent sessions

- Use Pi's ordinary session directory and `SessionManager`.
- Implement default `reuse` and replacement-style `fresh`.
- Serialize access to reusable sessions.
- Store role and skill identity with session metadata.
- Add `subagent-list` and basic status reporting.

### Phase 3: background and parallel execution

- Allow the parent tool call to return while a child continues running.
- Add completion reporting and explicit result retrieval.
- Add background jobs with durable identifiers and lifecycle state.
- Optionally run independent child sessions under a semaphore-based
  concurrency bound when multiple tool calls are issued together; this is a
  possible development, not a base-design requirement.
- Preserve per-session single-writer locking and define same-key behavior.
- Persist enough job state for restart, reload, cancellation, and recovery.

### Phase 4: optional structured results

Only if a concrete use case requires them:

- define explicit schemas for selected result types;
- validate and normalize structured output;
- consider a submission mechanism such as `submit_result`;
- keep structured output separate from the minimal text result.

### Phase 5: additional management UX

- Add commands to inspect, reset, compact, and resume role sessions.
- Add richer interactive and RPC observability.

## Decisions

1. Skills are the only role/instruction resource. Roles are ordinary skills
   whose names end in `-role`.
2. Role discovery uses Pi's normal skill inventory; no role catalog is
   hardcoded.
3. The parent-facing tool is named `subagent` and accepts a role, not a skill.
4. The `subagents` skill is general guidance loaded on demand; it is not a
   special role. The `subagent` tool is always registered.
5. The selected role skill is explicitly loaded into each child session.
6. There is one session per `(cwd, role)`. `reuse` is the default; `fresh`
   replaces the existing session. There is no `fork` mode in the base design.
7. Results are returned through the `subagent` tool.
8. Runtime constraints are enforced by the runner, with Pi project trust taking
   precedence.
9. Same-process SDK execution is preferred initially.
10. Persistent sessions use Pi's ordinary session directory for now.
11. Initial subagent execution is synchronous/awaited; background execution is
    a close future development target.
12. Independent parallel delegation is expressed by multiple `subagent` tool
    calls, and dependent sequential delegation by successive calls; an
    optional semaphore-based concurrency bound may govern active child sessions
    rather than a special batch mode.

## Open questions

- What user-visible behavior should concurrent requests for one role use while
  the single session is busy: queue, report `busy`, or another policy?
- For future background jobs, should completion be reported by notification,
  explicit result retrieval, parent-context injection, or a combination?
- If structured results become necessary, what explicit schemas and submission
  mechanism should they use?
- Should `subagent-list` retain replaced-session history, or show only the
  currently active session for each `(cwd, role)`?
- Could persistent sessions later move to a dedicated location?
