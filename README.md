# Pi Subagent Extension

This extension adds a `delegate` tool to Pi. A caller selects a predefined agent and supplies a task; the agent definition controls the child session’s prompt, model, tools, and skills. Child sessions can be continued and, if their tools allow it, can delegate again.

## Setup

Install this directory as a Pi package (for example, `pi install /path/to/pi-subagent`), or load `src/index.ts` as an extension. Then create at least one agent definition, for example `~/.pi/agent/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Review code for correctness and security
tools:
  "*": false
  read: true
  grep: true
  find: true
  ls: true
---

Review the requested changes. Report actionable findings with file references.
```

The body is appended to the child’s system prompt. This example disables every tool except the four listed, including `delegate`. Omit `tools` to leave Pi’s default child tool selection unrestricted. Rules match whole tool names case-sensitively; `*` is the only wildcard. Rules apply in order and the last match wins, so start with `"*": false` for an allowlist.

The extension reads `~/.pi/agent/agents/*.md` and, in a trusted project, `.pi/agents/*.md` under the session working directory. Project files take precedence over user files, with lexical ordering within each scope; the first valid definition for a name wins. Diagnostics are reported in two phases: structural, frontmatter, and model-resolution issues are reported as a root-session startup preflight; checks requiring the full skill catalog (including unknown `skills.preload` names and duplicate/winner outcomes that depend on those checks) are reported after discovery on the first root `before_agent_start`. The startup report is a preflight; the snapshot and diagnostics produced at first `before_agent_start` are authoritative. No parent-directory search is performed.

## Delegating

The model sees the names and descriptions of currently available agents when `delegate` is active. It can open a child with a request such as:

```json
{ "title": "Review the changes", "input": "Review the current diff for regressions.", "agent": "reviewer" }
```

A successful result includes a session ID. Continue that child with `continue_session` instead of `agent`:

```json
{ "title": "Review the fix", "input": "Check whether the latest change fixes your finding.", "continue_session": "<session-id>" }
```

A child starts with its own conversation, so include the relevant task context. Its agent configuration remains bound across continuations. Continuations of one child are serialized; different children can run concurrently. IDs are in-memory and become invalid on `/reload` or session shutdown. See [child session reuse](docs/DESIGN_REUSE.md) for ordering and results.

## Models and skills

An agent can add these optional frontmatter fields:

```yaml
model:
  - { id: claude-sonnet-4, provider: anthropic, thinkingLevel: high }
  - { id: other-model, thinkingLevel: medium }  # uses the live root provider
  - another-model  # ID-only candidate
skills:
  allowDiscovery: false
  preload: [code-review]  # must name an existing discovered skill
```

`model` accepts a string ID, one `{ id, provider?, thinkingLevel? }` mapping, or a non-empty ordered list mixing strings and mappings. A string, whether alone or in a list, is shorthand for an ID-only candidate and has no candidate options. Object candidates can specify different thinking levels for fallback entries. IDs are opaque, including slashes; values such as `parent` and `main` have no special meaning. A candidate without `provider` uses the live root provider. Candidates are checked in order by exact `(provider, id)` against the live root registry. Before selection, the extension skips matches whose provider has `ctx.modelRegistry.getProviderAuthStatus(provider).configured === false` and selects the first remaining match. If matches exist but all have unconfigured auth, the agent is unavailable with a provider-not-ready diagnostic; if no candidate matches, it is unavailable with a model-not-found diagnostic.

Omitting `model` inherits the immediate caller’s model and thinking level. An explicit selected candidate uses its own `thinkingLevel` if set, otherwise the new child session’s default, not the root or caller’s level. Resolution is live when building the digest and opening a child, so root model, registry, or auth changes affect later availability and openings without `/reload`; existing children retain their selected model and configuration across continuations. Configured auth means it is configured or resolvable, not that a request will succeed. Invalid or revoked credentials, insufficient scopes, quota issues, and other request failures remain runtime failures. Once a ready model is selected, auth, runtime, or request failures do not trigger fallback.

`allowDiscovery` defaults to `true`. Setting it to `false` hides the skill catalog from the child’s prompt, but does not block explicit `/skill:name` expansion. `preload` adds full skill bodies regardless of catalog visibility.

Agent definitions are captured for the runtime and refreshed by `/reload`. Definitions are validated in two phases: a startup preflight reports structural, frontmatter, and model-resolution diagnostics, then checks requiring the full root skill catalog run after skill discovery on the first root `before_agent_start`. A valid agent whose explicit model candidates have no exact match in the live root registry, or whose exact registry matches all have unconfigured auth, is omitted from the digest and reported as a root-session warning. Warnings include the agent name and source filename, provide a fix hint, and contain no secrets; no-match warnings also list attempted candidates. Availability is rechecked on every root `before_agent_start`, including after provider, registry, or auth changes, even when `delegate` is inactive. A warning is deduplicated while the agent remains continuously observed as unavailable; a check that finds it available clears the warning state, so it may warn again if it later becomes unavailable. `/reload` resets warning state. Omitted `model` (inherited model) and provider-runtime or request failures do not produce these warnings. Filenames are diagnostic only and do not appear in the digest.

Child sessions create their own Pi model runtimes. Providers must also be available to those runtimes; registering a provider only dynamically in the root does not automatically copy its implementation or credentials to children.

## Request fields

Opening calls require `agent`. Caller-supplied `agentPreset` and `skills` fields are not supported; model, tools, and skills policy belong to the selected agent definition.

## Development

```sh
npm install
npm test
npm run typecheck
```

See [agent definitions](docs/DESIGN_DEF.md), [delegation design](docs/DESIGN.md), and [child session reuse](docs/DESIGN_REUSE.md) for the full contracts.
