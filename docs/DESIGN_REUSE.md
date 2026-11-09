# Child session reuse

`delegate` supports two mutually exclusive request forms: an opening delegation that creates a child session, and a continuation delegation that adds a task to an existing child session. This lets callers preserve context across related tasks without introducing persistent session storage yet.

## Request forms

An opening delegation omits `continue_session` or specifies it as an empty string, and must name an `agent`. The selected definition is bound to the child session. See [Agent definitions](./DESIGN_DEF.md#invocation) for the invocation contract and agent configuration.

A continuation delegation specifies `continue_session` with a previously returned session ID. It must not specify `agent`: the child’s existing configuration is reused. The `input` is appended as a new user turn. An unknown, expired, or cwd-mismatched ID fails the tool call.

## Session lifetime

Child sessions are retained in memory for the lifetime of the current extension runtime. They are process-local handles rather than durable identifiers. Extension reload cancels active work, discards queued work, disposes child sessions, and invalidates their IDs. Cancellation of an opening is reported promptly, but Pi’s resource reload, session creation, and extension binding do not accept cancellation signals. An in-flight setup stage may therefore continue; the extension stops before subsequent stages and cleans up after that stage settles, while runtime shutdown waits for the tracked opening. Persistent child sessions and indefinite retention are future work.

## Continuation ordering

Continuations of the same child session that reach the extension queue are serialized. When an assistant message issues multiple such calls, they run in assistant tool-call order; each call receives its own result. A failed or cancelled queued request stops later requests in that batch, including requests that were still queued. Continuation validation failures for a known, same-cwd child are queued as well, so they stop later requests in the batch. Those skipped calls receive individual agent-readable failure results. This ordering guarantee does not cover calls Pi rejects or blocks before invoking the extension. The child session itself remains available for a later, separately issued continuation.

Different child sessions may be processed concurrently.

## Results

Only a successfully completed request exposes the session ID. The agent-readable result uses an XML-like envelope (with `text` present when the response contains text):

```xml
<delegate_result>
  <status>completed</status>
  <session_id>...</session_id>
  <text>...</text>
</delegate_result>
```

Failures and cancellations use the same envelope with `error` instead of `session_id` and `text`. Text and errors are XML-escaped. The structured `details` metadata may also contain `sessionId` for UI and extension consumers, but `details` is not agent-readable; the XML content is the authoritative caller-facing contract.

Normal completion, Pi errors, and Pi aborts map to `completed`, `failed`, and `cancelled` respectively. Failed or cancelled opening requests are not retained because their IDs were never exposed; failed or cancelled continuations retain the existing child session for later reuse.

## Usage accounting

Each invocation reports only its newly persisted attributable usage, rather than the retained child session's cumulative history. It is propagated through `AgentToolResult.usage`, separately from the model-facing XML envelope. If no attributable usage is reported, none is estimated.

Nested delegation usage is already carried by the child session's persisted `toolResult` usage. It is included once; accounting does not traverse descendant sessions. Known reported usage can also be included on failed or cancelled tool results if the host persists them.

Standalone asynchronous or otherwise unassignable usage entries, such as cache warming, are excluded even when they appear during the invocation's snapshot window. The resulting totals are settled attributable usage, not a guarantee of invoice parity.
