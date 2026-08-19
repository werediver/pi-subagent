# Role-free subagents

## Overview

A role-free subagent has no fixed role and no role definition resource type is needed.

A subagent invocation then involves:

- a task,
- skills to pre-load,
- a model class.

The task defines the immediate objective, pre-loaded skills bootstrap the session, and the model class selects the required capability level of the model backing the session.

This approach allows for a small implementation, uniform skill reuse, and expressive power similar to role-based subagents.

## Skills over roles

Roles are, arguably, inconsequential; skills are what matters for good performance.

Instead of what a `researcher` role is, define how to `research`, etc.

The invocation may specify skills to be pre-loaded into a subagent session:

```ts
delegate({
  task: "Review the authentication changes for security and correctness.",
  skills: ["code-review", "security-review"],
  modelClass: "alternative",
})
```

This guarantees loading of the skills essential for the task execution and saves a few turns in the new session that otherwise would be spent on decision making and (possibly) loading the skills.

## Delegation as a skill

Choosing when and how to delegate is itself a skill, a `task-delegation` skill. This skill belongs primarily in the main session context (but may be used for nested subagent invocation too). It can describe how to:

- recognize work that benefits from delegation;
- formulate a self-contained task;
- choose the worker's skills;
- choose an appropriate model class; and
- request a useful, self-contained result.

For example, the calling agent may follow `task-delegation` and produce:

```ts
delegate({
  task: "Investigate the failing session recovery test and explain the cause.",
  skills: ["research", "debugging"],
  modelClass: "fast",
})
```

## Model classes

The caller selects a model _class_ name, not an exact model identifier. Names such as `parent`, `main`, `alternative`, and `fast` are examples; deployments can define others.

The final vocabulary is deployment-facing configuration, but the classes have
the following intended meanings:

- **`parent`** — inherit the model resolved for the immediately calling agent.
- **`main`** — use the model resolved for the main session.
- **`alternative`** — use a configured model intended to produce a meaningfully different perspective, such as for code review or a second opinion.
- **`fast`** — use a configured model optimized for latency and/or cost.

If `modelClass` is omitted, resolution defaults to `parent` class.

Delegated sessions can invoke `delegate` themselves. A child loads the normal extension set, while this extension is registered again with the top-level session's model settings. Thus, `parent` always resolves relative to the immediate caller, while `main` resolves relative to the top-level session at every nesting depth.

## Model class configuration and cost safety

The implementation owns the mapping from classes to concrete provider/model configuration. If not specified, `provider` defaults to the main session's provider. A model class can be derived from a `base` class overriding some of its properties. An optional `description` is shown to agents when they choose a class. The built-in `parent` and `main` classes have default descriptions; if configured, they must specify a `description` and no other properties, overriding the defaults.

```json
{
  "modelClasses": {
    "parent": {
      "description": "Use the calling agent's model"
    },
    "main": {
      "description": "Use the top-level session's model"
    },
    "fast": {
      "model": "fast-model",
      "thinkingLevel": "low",
      "description": "Optimized for latency and cost"
    },
    "alternative": {
      "model": "independent-review-model",
      "provider": "provider",
      "description": "A meaningfully different perspective"
    },
    "alternative-fast": {
      "base": "alternative",
      "thinkingLevel": "low",
      "description": "A fast independent review"
    }
  }
}
```

This gives model selection the following properties:

- The calling model can express intent without knowing the exact model names
- The implementation retains control over concrete models and cost
- Deployments can change model mappings without changing skills or callers

### Project-level overrides

The project-level extension configuration can define new model classes or replace certain classes from the global configuration.

## Invocation interface

The invocation parameters are:

```ts
type SubagentRequest = {
  title: string;
  task: string;
  skills?: string[];
  modelClass?: string;
};
```

An example invocation:

```ts
delegate({
  title: "Investigate regression",
  task: "Find the cause of the regression and return evidence and a concise recommendation.",
  skills: ["research", "debugging"],
  modelClass: "fast",
})
```

The caller must include the relevant context in the task, because the parent session is not shared with the child.

## Result and composition

The initial result can remain minimal:

```ts
type SubagentResult = {
  status: "completed" | "failed" | "cancelled";
  text?: string;
  error?: string;
};
```

The child returns its final response as labeled tool output. It should not be
silently inserted into the parent as an unlabeled user message.

Independent invocations can be started concurrently via batched tool calls. Dependent work is expressed through staged tool calls with the parent passing the previous result into the next task.
