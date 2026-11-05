# Agent definitions

A delegation names a predefined agent rather than assembling capabilities at each call site. The caller supplies *which agent* and *what task*; the agent definition supplies its prompt and runtime configuration. See [DESIGN.md](./DESIGN.md) for the overall delegation model.

## Terminology

- **Agent definition** (or **agent**): a Markdown file discovered from an `agents/` directory. It has a name, optional description, frontmatter configuration, and an optional system-prompt body.
- **Agent snapshot**: the immutable set of statically validated agent definitions. It is created in the root session and shared with descendants. It does not freeze the active root model/provider; descendants resolve against the root session's current model context.
- **Agent digest**: the available agent names and optional descriptions appended to a session's system prompt when delegation is possible. It contains no agent bodies or source-scope information.

## Agent definition files

An agent is a Markdown file whose body is its system prompt and whose YAML frontmatter is configuration:

```yaml
---
name: reviewer
description: Code review specialist for quality and security analysis
tools:
  "*": false
  read: true
  grep: true
  find: true
  ls: true
  bash: true
model: claude-sonnet-4
provider: anthropic
thinkingLevel: high
skills:
  allowDiscovery: false
  preload: [code-review]
---

You are a senior code reviewer. ...
```

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | Yes, non-empty | Identifier used by the `delegate` tool and shown in the digest. Names are compared exactly after trimming surrounding whitespace. |
| `description` | No | One-line purpose shown in the digest. |
| `tools` | No | Ordered mapping from tool-name patterns to booleans. Omitted means no additional restriction on Pi’s default child tool selection. |
| `model` | No | A concrete model ID only. Omitted means inherit the calling session's model. |
| `provider` | No | Provider for a concrete model ID. It is invalid without `model`; when omitted, the live root session model's provider is used. |
| `thinkingLevel` | No | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `skills.allowDiscovery` | No | Whether the discovered skill catalog is included in the prompt. Defaults to `true`. |
| `skills.preload` | No | Skill names whose full bodies are force-loaded. Defaults to empty. |

Model values are never interpreted as aliases or preset names. In particular, `parent` and `main` have no built-in meaning: if either is used as a `model` value, it is looked up as an ordinary concrete model ID. There is no model alias or preset configuration, and the extension does not read `subagent.json`.

Tool names are matched case-sensitively against the whole name; `*` is the only wildcard and matches any run of characters, including none. Every tool starts enabled, rules apply in declaration order, and the last matching rule wins. An unmatched tool remains enabled. Patterns need not match a tool in the current session. The mapping shape is validated, but tool names are not required to be known at discovery time. Pi parses mappings as JavaScript objects, so integer-index-like keys are evaluated before other keys regardless of their YAML order.

The body may be empty. When spawned, it is appended to the child session's system prompt; it is never part of the digest. The selected definition and its configuration are bound to that child for its lifetime.

## Discovery and snapshot

Agent files follow the existing user/project trust boundary:

- User agents: `~/.pi/agent/agents/*.md`, always loaded.
- Project agents: `.pi/agents/*.md` under the session's working directory, loaded only when the project is trusted. There is no ancestor-directory search.

The root session creates one snapshot during initial discovery. Trusted project files are considered before user files, with files in each scope ordered lexicographically by path. The first valid definition with a given name is accepted; later definitions with that name are reported and ignored. Thus a valid project definition overrides a user definition. A rejected file does not claim its name, so an invalid project definition does not shadow a valid user definition.

Descendant sessions reuse the same snapshot rather than rediscovering or reparsing files. Each digest build and opening delegation consults the latest root model/provider, including in nested sessions. A root model/provider change therefore affects subsequent digests and delegations without `/reload`. Changes to agent files are picked up by Pi's `/reload`, which rebuilds the snapshot. A runtime reload also invalidates existing child sessions as described in [DESIGN_REUSE.md](./DESIGN_REUSE.md); continuations cannot outlive that reload.

## Validation

Static validation occurs while building the root snapshot. A rejected definition is excluded from the digest and invocable set, and its file and reason are reported in the root session. Unknown frontmatter fields are reported and ignored; they do not reject an otherwise valid definition. Malformed or unparseable frontmatter, or an invalid known field, rejects the definition. Model availability is context-dependent and is checked when building a digest and when opening a delegation, not frozen into the snapshot. A request for a statically rejected or unknown agent fails with an unknown-agent error; a known agent that cannot resolve in the current model context fails with a model-resolution error.

Validation covers:

- a non-empty `name`;
- a valid `tools` mapping with non-empty patterns and boolean values;
- a non-empty concrete `model` ID when present;
- a `provider` that is specified only alongside `model`; model/provider availability is checked against the current root model registry at digest and invocation time;
- an accepted `thinkingLevel`;
- a well-formed `skills` mapping whose `preload` names exist.

A known agent may be unavailable in the current model context—for example, when a concrete model ID is not registered for the current default provider. It is omitted from that context's digest and becomes available again if the root model/provider changes to a compatible context. If requested while unavailable, opening the delegation fails with the current resolution error. These changes do not mutate or rebuild the agent snapshot.

## Model selection

When `model` is omitted, an agent inherits the immediate calling session's current model and thinking level. Its explicit `thinkingLevel`, if any, overrides the inherited level. This makes nested delegation follow the actual caller, not automatically the root session.

When `model` is present, it is always resolved as a concrete model ID. The explicit frontmatter `provider` is used when present; otherwise the provider from the live root session model is used. The model is looked up by the `(provider, ID)` pair in the live root registry. A concrete selection does not inherit the root or caller thinking level; an explicit frontmatter `thinkingLevel` applies, otherwise the new child session uses its normal default. A concrete model with no explicit provider cannot resolve while the root has no active model/provider.

Root model/provider changes affect later prompt digests and opening delegations immediately; they do not require `/reload`. Existing children retain their selected model and configuration.

## Skills policy

The caller no longer passes skills. An agent declares its own policy:

- `allowDiscovery: true` includes the discovered skill catalog according to Pi's normal prompt behavior.
- `allowDiscovery: false` hides only the catalog. Discovered skills remain available, and an agent that already knows a skill name can still load it.
- `preload` force-loads full skill bodies regardless of catalog visibility.

`allowDiscovery` defaults to `true` and `preload` to empty.

## Invocation

The `delegate` contract is:

```ts
type DelegateRequest = {
  title: string;
  input: string;
  agent?: string;          // required for opening delegations
  continue_session?: string;
};
```

- `agent` is required for an opening delegation and is bound to the child session.
- A continuation must not specify `agent`; the existing child's configuration is reused.
- `title`, `input`, the result envelope, continuation ordering, and in-process child sessions are unchanged.

## Digest

The digest lists validated agents from the root snapshot: name and optional description only, with no bodies or source scope. It is appended to the system prompt of every session in which delegation is possible. "Possible" means the `delegate` tool is active: a root session with the tool enabled sees the digest, as does a nested child whose tool rules leave `delegate` active. A definition whose rules disable `delegate` sees no digest.

## Boundaries and deferred work

- Async delegation, persistent child sessions, and parallel delegation remain the subject of their own designs; this document does not change them.
- Richer agent capabilities (for example, agent-declared runtime settings beyond tools, model, thinking level, and skills) are out of scope.
