# Subagents in Pi

## Model and scope

A subagent is an ordinary Pi `AgentSession` running under a role skill. The
`subagent` tool creates or resumes that session and returns its result to the
calling agent. Skills are the only instruction and role resource: there is no
separate role definition, agent type, or special session class.

The design supports focused delegation, persistent specialist context, and
predictable role behavior. The runner—not model instructions—enforces tools,
timeouts, cancellation, persistence, and concurrency. It does not add
subagent semantics to Pi core, share the parent's complete conversation, merge
child transcripts into the parent, or support multiple same-role sessions or
forks in the base design.

## Skills, roles, and child context

Skills use Pi's normal inventory and may be global, project-local, or
package-provided. A role is a specialist skill whose name conventionally ends
in `-role`; ordinary skills remain reusable capabilities. The `role` argument
accepts either the base name or the full skill name and canonicalizes both to
the same identity:

```text
researcher       -> researcher-role
researcher-role  -> researcher-role
```

Role discovery is not hardcoded. An unknown role produces a clear error rather
than creating an unconfigured session. No role catalog or `.pi/roles/`
directory is introduced. A role skill defines the specialist's identity,
methodology, constraints, and useful result format; it can be stored using the
normal layout, for example:

```text
~/.pi/agent/skills/researcher-role/SKILL.md
```

`subagents` is an ordinary skill containing guidance about when and how to
delegate, discover roles, formulate tasks, and use results. It may be loaded
by any agent, but the `subagent` tool is always registered.

When creating a child, the runner explicitly loads the resolved role skill.
The initial child context contains only:

1. the role contract;
2. a short execution envelope;
3. the task; and
4. the expected result contract.

The child does not receive the parent's full conversation. It may discover and
use ordinary skills normally. Recursive delegation is disabled for role
sessions by default; if enabled later, the runner must enforce a maximum depth.

## The `subagent` tool

```ts
type SubagentRequest = {
  role: string;
  task: string;
  mode?: "reuse" | "fresh";
  timeoutMs?: number;
  tools?: string[];
};
```

For example:

```ts
subagent({
  role: "researcher",
  task: "Investigate how session persistence works in this repository.",
});
```

The child inherits the parent's working directory; an explicit child `cwd` is
not part of the base request. The runner owns role resolution, session lookup,
locking, child creation, prompting, result collection, cancellation, and
persistence.

`tools`, when supplied, may only narrow the role's permitted tools. It cannot
expand permissions or bypass Pi's project-trust behavior, and names use Pi's
normal registered tools. The runner also enforces the role's base tool policy,
model and thinking level, timeout, nesting depth, and result limits. A
read-only role should therefore be given no `write` or `edit` capability; an
instruction not to edit is not the safety boundary.

## Session identity and lifecycle

There is at most one current subagent session for each:

```text
working directory + canonical role skill
```

The working directory is the session context and user-provided scope is omitted
from the base design. Different parent sessions referring to the same key share
its child and single-writer lock.

- **`reuse` (default):** continue the session for the key, or create it if it
  does not exist. This preserves specialist context across requests and process
  restarts.
- **`fresh`:** wait for the current session's lock, replace the current
  mapping, and create a new session with the role skill and task. The old
  transcript may remain in Pi's ordinary storage for diagnostics, but the
  registry points only to the replacement. There is no `fork` mode or active
  session pool.

Before reuse, the runner must verify that the role skill still resolves and
that its identity/content has not changed. A stale or unavailable role
contract must never be used to invoke the child; the runner should create a
replacement when the current contract is available, or report/ignore the
entry when it is not.

## Persistence, recovery, and concurrency

Persistent role sessions use Pi's existing `SessionManager` and JSONL files in
Pi's ordinary session directory for now; a dedicated storage location may be
considered later. The in-memory registry is a runtime cache.
When a child is activated, the extension persists the relationship in the
parent session's custom entries, including the canonical role, resolved skill,
working directory, session ID/file, role fingerprint or version, and last-used
time. These entries are the durable association; locks, active session
objects, timers, and event subscriptions are recreated at runtime.

On initialization or parent-session resume, the extension replays the entries
to reconstruct mappings. Recovered sessions start idle and may be opened lazily.
Recovery resolves every role through the current skill inventory. If a role no
longer resolves after a restart or configuration reload, its session is left
unused rather than invoked without its contract; the entry may remain for
diagnostics or later recovery. Multiple parent sessions referencing one key
share its mapping and lock instead of creating competing children.

A session is a single-writer resource: same-key requests must not interleave
prompts; requests for a busy session queue behind its lock and remain
cancellable. Different keys may run concurrently when the Pi host dispatches
multiple tool calls concurrently. An optional extension-wide semaphore may
later bound actively executing child prompts. Waiting for a per-session lock
should not consume a semaphore slot. The semaphore limits concurrency but does
not create it; no batch mode is required.

The runner's core lifecycle is:

1. resolve and canonicalize the role skill;
2. resolve the session key and acquire its lock;
3. create, open, or replace the child session;
4. prompt it with the role contract, envelope, task, and result contract;
5. collect and normalize the result;
6. release the lock; and
7. return the result to the parent.

Cancellation aborts the child. Wall-clock timeouts and cancellation must be
distinguished from ordinary failure. A child failure normally becomes a failed
result rather than crashing the parent.

## Results and observability

The initial result is deliberately minimal:

```ts
type SubagentResult = {
  status: "completed" | "failed" | "cancelled" | "timeout";
  text?: string;
  error?: string;
};
```

`text` is the child's final assistant response. The tool returns the result as
its labeled tool result; it must not silently insert child text into the parent
as an unlabeled user message. Child identity, session paths, task IDs, usage,
and other execution details are registry or observability metadata, not part
of the core result. Role skills should request a self-contained report when
useful.

`subagent-list` is an operational view of sessions activated through the tool,
not a catalog of available roles. Each entry should show the role and resolved
skill, working directory, session ID or file, busy/idle state, last-used time,
and whether the current session was created through `reuse` or `fresh`.
Interactive extensions may add status widgets, lifecycle notifications, and
transcript access; RPC/JSON integrations may expose lifecycle start/end events.
Streaming every child token is not the default.

## Execution and delegation

The preferred initial implementation is same-process SDK usage:

- `createAgentSession()` creates children;
- `SessionManager` handles persistence;
- `AgentSession.prompt()` runs tasks; and
- session events provide progress and result collection.

Initial execution is synchronous: the tool waits for the child prompt and
returns its `SubagentResult`. Independent work is expressed through multiple
`subagent` calls in one assistant turn; it is concurrent only if the host
dispatches those calls concurrently, and remains subject to same-key locks and
any semaphore. Dependent work uses successive calls, with the parent passing
returned results into the next task. The runner does not infer dependencies,
automatically pass results, or maintain a workflow graph. This supports
research → plan → implementation without chain syntax or a separate
orchestration protocol.

Background (detached) execution—returning before the child completes—is out
of scope for this design. A base `subagent` call remains pending until its
child finishes and returns a normal `SubagentResult`; independent calls may
still run concurrently when the host supports it. If detached execution is
needed later, a separate durable job API could return a job ID and provide
explicit result retrieval, with notifications as an optional convenience. It
would require its own lifecycle, cancellation, persistence, recovery, and
reporting rules. Subprocess execution through `pi --mode rpc` is another
optional future choice for process isolation or hard termination.

## Implementation phases

1. **One-shot:** register the always-available tool, resolve role skills,
   create in-memory sessions, pass role context and task, return final text,
   and add basic cancellation, timeout, and tool restrictions.
2. **Persistent sessions:** use `SessionManager`, implement `reuse` and
   replacement-style `fresh`, serialize same-key access, track role identity,
   and add `subagent-list`.
3. **Operational limits:** add restart recovery and an optional semaphore
   while preserving single-writer locks.
4. **Management UX:** add inspection, reset, compaction, resume, and richer
   interactive or RPC observability.

## Open questions

- Where should per-role base tool/model/thinking policies and role
  fingerprint/versioning be configured?
- Should `subagent-list` retain replaced-session history?
