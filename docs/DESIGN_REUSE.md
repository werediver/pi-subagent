# Child session reuse

`delegate` supports two mutually exclusive request forms: an opening delegation that creates a child session, and a continuation delegation that adds a task to an existing child session. This lets callers preserve context across related tasks without introducing persistent session storage yet.

## Request forms

An opening delegation omits `continue_session` or specifies it as an empty string. It may specify `modelClass` and `skills`; `modelClass` defaults to `parent`.

A continuation delegation specifies `continue_session` with a previously returned session ID. It must not specify `modelClass` or `skills`: the child’s existing configuration is reused. The task is appended as a new user turn. An unknown, expired, or cwd-mismatched ID fails the tool call.

## Session lifetime

Child sessions are retained in memory for the lifetime of the current extension runtime. They are process-local handles rather than durable identifiers. Extension reload cancels active work, discards queued work, disposes child sessions, and invalidates their IDs. Persistent child sessions and indefinite retention are future work.

## Continuation ordering

Continuations of the same child session are serialized. When an assistant message issues multiple continuation tool calls, they run in assistant tool-call order; each call receives the result of its own task. A failed or cancelled request stops all later requests in that chain, including requests that were still queued. Those skipped calls receive individual agent-readable failure results. The child session itself remains available for a later, separately issued continuation.

Different child sessions may be processed concurrently.

## Results

Only a successfully completed request exposes the session ID. The agent-readable result uses an XML-like envelope:

```xml
<delegate_result>
  <status>completed</status>
  <session_id>...</session_id>
  <text>...</text>
</delegate_result>
```

Failures and cancellations use the same envelope with `error` instead of `session_id` and `text`. Text and errors are XML-escaped. The structured `details` metadata may also contain `sessionId` for UI and extension consumers, but `details` is not agent-readable; the XML content is the authoritative caller-facing contract.

Normal completion, Pi errors, and Pi aborts map to `completed`, `failed`, and `cancelled` respectively. Failed or cancelled opening requests are not retained because their IDs were never exposed; failed or cancelled continuations retain the existing child session for later reuse.
