import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, ModelRegistry, ModelRuntime, type Skill } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, fakeContext } from "./extension-harness.ts";
import type { DelegateCmdResult } from "../src/result.ts";

// This extension is discovered separately by every real nested resource loader. In
// particular, its provider is not registered on the root's model runtime.
function writeFakeProvider(agentDir: string, logPath: string) {
	const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	const source = `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
const log = (value) => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + "\\n");
export default function (pi) {
  log({ type: "factory" });
  for (const [provider, api, ids] of [["nested-test", "nested-test-api", ["nested-model", "parent", "main"]], ["alternate-test", "alternate-test-api", ["alternate-model", "parent", "main"]]]) pi.registerProvider(provider, {
    baseUrl: "https://invalid.example", apiKey: "test-key", api,
    // Deliberately omit switch-target: it exists only in the root registry.
    models: ids.map(id => ({ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.text || "").join(""));
      const results = context.messages.filter(m => m.role === "toolResult");
      const lastUserIndex = context.messages.findLastIndex(m => m.role === "user");
      const turnResults = context.messages.slice(lastUserIndex + 1).filter(m => m.role === "toolResult");
      log({ type: "request", provider: model.provider, model: model.id, reasoning: options?.reasoning, systemPrompt: context.systemPrompt, users, results, turnResults, tools: (context.tools || []).map(t => t.name) });
      if (model.provider === "nested-test" && users.at(-1) === "fail after selection") throw new Error("intentional selected model failure");
      if (users.at(-1) === "fail continuation") throw new Error("intentional continuation failure");
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      const prompt = users.at(-1);
      let args;
      if (prompt === "child initial" && turnResults.length === 0) args = { title: "Grandchild", input: "grandchild prompt", agent: "grandchild" };
      if (prompt === "child continuation") {
        const grandchildId = results[0]?.details?.sessionId;
        const calls = [
          { title: "Resume grandchild", input: "grandchild continuation", continue_session: grandchildId },
          { title: "Child main", input: "child main leaf", agent: "main" },
          { title: "Child dynamic", input: "child dynamic leaf", agent: "dynamic" },
          { title: "Child parent", input: "child parent leaf", agent: "parent" },
        ];
        args = calls[turnResults.length];
      }
      if (prompt === "grandchild continuation") {
        const calls = [
          { title: "Grandchild main", input: "grandchild main leaf", agent: "main" },
          { title: "Grandchild dynamic", input: "grandchild dynamic leaf", agent: "dynamic" },
          { title: "Grandchild parent", input: "grandchild parent leaf", agent: "parent" },
        ];
        args = calls[turnResults.length];
      }
      if (prompt === "no root model") {
        const calls = [
          { title: "Missing provider", input: "must not run dynamic", agent: "dynamic" },
          { title: "Missing main", input: "must not run main", agent: "main" },
          { title: "Caller inheritance", input: "no root inherited leaf", agent: "inherit" },
          { title: "Explicit fallback", input: "no root fallback leaf", agent: "fallback" },
        ];
        args = calls[turnResults.length];
      }
      if (args) {
        const call = { type: "toolCall", id: "nested-call-" + turnResults.length, name: "delegate", arguments: args };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = "toolUse";
      } else {
        const text = prompt === "grandchild prompt" ? "grandchild answer" : prompt === "child initial" ? "child answer" : prompt + " answer";
        message.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        message.stopReason = "stop";
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    }
  });
}`;
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "fake-provider.js"), source);
}

test("nested sessions share the agent snapshot while root models remain live, until reload", async () => {
	const rootDir = mkdtempSync(join(tmpdir(), "pi-nested-runtime-"));
	const agentDir = join(rootDir, "agent");
	const project = join(rootDir, "project");
	const logPath = join(rootDir, "provider.jsonl");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	const skillDir = join(agentDir, "skills", "nested-check");
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, "---\nname: nested-check\ndescription: Nested test skill\n---\nNESTED-SKILL-BODY\n");
	// The fake root context does not run resource discovery; provide its catalog
	// explicitly. The hidden skill is outside both discovery roots, as if supplied
	// only by a root extension; a child's initial loader cannot discover it.
	const rootOnlyDir = join(rootDir, "root-only-skill");
	mkdirSync(rootOnlyDir, { recursive: true });
	const rootOnlyPath = join(rootOnlyDir, "SKILL.md");
	writeFileSync(rootOnlyPath, "---\nname: root-only\ndescription: Hidden root-only skill\ndisable-model-invocation: true\n---\nROOT-ONLY-SKILL-BODY\n");
	const rootSkills = [
		{ name: "nested-check", filePath: skillPath, baseDir: skillDir },
		{ name: "root-only", filePath: rootOnlyPath, baseDir: rootOnlyDir, disableModelInvocation: true },
	] as Skill[];
	const putAgent = (name: string, frontmatter: string, body: string) => writeFileSync(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\n${frontmatter}---\n${body}\n`);
	const nestedRules = "tools:\n  '*': false\n  read: true\n  delegate: true\n  bash: false\nskills:\n  preload: [nested-check]\n";
	const leafRules = "tools:\n  '*': false\n  read: true\n  bash: false\n";
	putAgent("child", nestedRules.replace("preload: [nested-check]", "preload: [nested-check, root-only]"), "AGENT-BODY-CHILD");
	putAgent("grandchild", nestedRules, "AGENT-BODY-GRANDCHILD");
	putAgent("main", `model: { id: main, thinkingLevel: high }\n${leafRules}`, "MAIN-AGENT-BODY");
	putAgent("dynamic", `model: { id: switch-target, thinkingLevel: medium }\n${leafRules}`, "DYNAMIC-AGENT-BODY");
	putAgent("fallback", `model:\n  - { id: main, thinkingLevel: high }\n  - { id: alternate-model, provider: alternate-test, thinkingLevel: low }\n${leafRules}`, "FALLBACK-AGENT-BODY");
	putAgent("no-request-fallback", `model:\n  - { id: main, provider: nested-test, thinkingLevel: high }\n  - { id: alternate-model, provider: alternate-test, thinkingLevel: low }\n${leafRules}`, "NO-REQUEST-FALLBACK-BODY");
	putAgent("parent", `model: { id: parent, thinkingLevel: low }\n${leafRules}`, "PARENT-AGENT-BODY");
	putAgent("inherit", leafRules, "INHERIT-AGENT-BODY");
	putAgent("unavailable", `model: { id: registered-no-auth, provider: unconfigured-test }\n${leafRules}`, "UNAVAILABLE-AGENT-BODY");
	writeFakeProvider(agentDir, logPath);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const harness = createExtensionHarness();
	let reloadedHarness: ReturnType<typeof createExtensionHarness> | undefined;
	const { ctx, notifications } = fakeContext(project);
	// Avoid UI rendering in the headless test.
	Object.defineProperty(ctx.ui, "theme", { value: undefined });
	try {
		// This registry supplies real model metadata to the root, but is not shared
		// with child sessions. Only the discovered extension supplies their stream.
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		registry.registerProvider("nested-test", {
			baseUrl: "https://invalid.example", apiKey: "test-key", api: "nested-test-api",
			models: ["nested-model", "parent", "main"].map(id => ({ id, name: id, reasoning: true, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 })),
		});
		registry.registerProvider("alternate-test", {
			baseUrl: "https://invalid.example", apiKey: "test-key", api: "alternate-test-api",
			models: ["alternate-model", "switch-target", "parent", "main"].map(id => ({ id, name: id, reasoning: true, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 })),
		});
		registry.registerProvider("unconfigured-test", {
			baseUrl: "https://invalid.example", apiKey: "test-key", api: "unconfigured-test-api",
			models: [{ id: "registered-no-auth", name: "Registered without auth", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
		});
		const getProviderAuthStatus = registry.getProviderAuthStatus.bind(registry);
		registry.getProviderAuthStatus = (provider) => provider === "unconfigured-test" ? { configured: false } : getProviderAuthStatus(provider);
		const model = registry.find("nested-test", "nested-model");
		assert.ok(model);
		Object.assign(ctx, { model, modelRegistry: registry });
		// Build the static snapshot. Agent digests are deliberately not asserted:
		// they are implemented in Phase 4, not the invocation migration.
		harness.beforeStart(ctx, ["delegate"], "base prompt", rootSkills);
		const unavailableWarnings = () => notifications.filter(({ message }) => message.includes('for agent "unavailable"'));
		assert.equal(unavailableWarnings().length, 1);
		assert.ok(unavailableWarnings()[0].message.includes(join(agentDir, "agents", "unavailable.md")));
		assert.match(unavailableWarnings()[0].message, /registered, but provider auth is not configured/);
		assert.doesNotMatch(unavailableWarnings()[0].message, /test-key/, "auth diagnostics do not expose credentials");
		const missingAgent = (await harness.execute(ctx, { title: "Missing agent", input: "must not run" })).details as DelegateCmdResult;
		assert.equal(missingAgent.status, "failed");
		assert.match(missingAgent.error!, /agent/i);
		const unknownAgent = (await harness.execute(ctx, { title: "Unknown agent", input: "must not run", agent: "unknown" })).details as DelegateCmdResult;
		assert.equal(unknownAgent.status, "failed");
		assert.match(unknownAgent.error!, /unknown.*agent|agent.*unknown/i);
		const records = () => readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const requests = () => records().filter(r => r.type === "request");
		const initial = (await harness.execute(ctx, { title: "Child", input: "child initial", agent: "child" })).details as DelegateCmdResult;
		assert.equal(initial.status, "completed", JSON.stringify(initial));
		assert.ok(initial.sessionId);
		assert.equal(initial.text, "child answer");
		assert.equal(unavailableWarnings().length, 1, "nested before_agent_start checks do not duplicate auth warnings");
		const [child, grandchild, childAfterTool] = requests();
		assert.equal(records().filter(r => r.type === "factory").length, 2);
		for (const request of [child, grandchild]) {
			assert.equal(request.provider, "nested-test");
			assert.equal(request.model, "nested-model");
			assert.match(request.systemPrompt, /NESTED-SKILL-BODY/);
			assert.ok(request.tools.includes("delegate"));
			assert.ok(request.tools.includes("read"));
			assert.ok(!request.tools.includes("bash"));
			assert.ok(!request.tools.includes("write"));
		}
		assert.match(child.systemPrompt, /AGENT-BODY-CHILD/);
		assert.match(child.systemPrompt, /ROOT-ONLY-SKILL-BODY/);
		assert.match(childAfterTool.systemPrompt, /ROOT-ONLY-SKILL-BODY/);
		assert.doesNotMatch(child.systemPrompt, /AGENT-BODY-GRANDCHILD/);
		assert.match(grandchild.systemPrompt, /AGENT-BODY-GRANDCHILD/);
		assert.doesNotMatch(grandchild.systemPrompt, /AGENT-BODY-CHILD|ROOT-ONLY-SKILL-BODY/);
		assert.deepEqual(grandchild.users, ["grandchild prompt"]);
		assert.equal(childAfterTool.results[0].isError, false);
		const grandchildId = childAfterTool.results[0].details?.sessionId;
		assert.ok(grandchildId);
		assert.notEqual(grandchildId, initial.sessionId);
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		const invalidContinuation = (await harness.execute(ctx, { title: "Invalid continuation", input: "must not run", agent: "child", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(invalidContinuation.status, "failed");
		assert.match(invalidContinuation.error!, /agent/i);
		const afterInvalid = (await harness.execute(ctx, { title: "Valid but skipped", input: "must be skipped after invalid", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(afterInvalid.status, "failed");
		assert.match(afterInvalid.error!, /skipped because the previous continuation failed/i);
		assert.equal(requests().some(r => r.users.at(-1) === "must be skipped after invalid"), false);
		await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);

		// Change agent definitions after snapshot creation. The replacement child
		// disables delegate, making continuation reuse observable.
		putAgent("child", leafRules, "RELOADED-CHILD-BODY");
		putAgent("dynamic", `model: { id: alternate-model, thinkingLevel: low }\n${leafRules}`, "RELOADED-DYNAMIC-BODY");
		const afterEdit = (await harness.execute(ctx, { title: "New after edit", input: "new after edit", agent: "child" })).details as DelegateCmdResult;
		assert.equal(afterEdit.status, "completed", JSON.stringify(afterEdit));
		assert.ok(afterEdit.sessionId);
		const newChild = requests().find(r => r.users.at(-1) === "new after edit");
		assert.ok(newChild);
		assert.match(newChild.systemPrompt, /AGENT-BODY-CHILD/);
		assert.match(newChild.systemPrompt, /NESTED-SKILL-BODY/);
		assert.match(newChild.systemPrompt, /ROOT-ONLY-SKILL-BODY/);
		assert.doesNotMatch(newChild.systemPrompt, /RELOADED-CHILD-BODY/);
		assert.ok(newChild.tools.includes("delegate"));

		// Mutate the very same root context after both nested sessions exist.
		const alternate = registry.find("alternate-test", "alternate-model");
		assert.ok(alternate);
		Object.assign(ctx, { model: alternate, thinkingLevel: "high" });
		const continued = (await harness.execute(ctx, { title: "Continue", input: "child continuation", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(continued.status, "completed", JSON.stringify(continued));
		assert.equal(continued.sessionId, initial.sessionId);
		assert.equal(continued.text, "child continuation answer");

		// A later tool call in the same assistant turn remains in the failed batch,
		// even though the first call has fully drained the child queue.
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		const failedContinuation = (await harness.execute(ctx, { title: "Fail", input: "fail continuation", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(failedContinuation.status, "failed", JSON.stringify(failedContinuation));
		const skippedContinuation = (await harness.execute(ctx, { title: "Skip", input: "skipped continuation", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(skippedContinuation.status, "failed");
		assert.match(skippedContinuation.error!, /skipped because the previous continuation failed/i);
		assert.equal(requests().some(r => r.users.at(-1) === "skipped continuation"), false);
		await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);

		// A distinct assistant turn gets a fresh batch and can reuse the child.
		await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		const laterContinuation = (await harness.execute(ctx, { title: "Reuse", input: "later continuation", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(laterContinuation.status, "completed", JSON.stringify(laterContinuation));
		assert.equal(laterContinuation.sessionId, initial.sessionId);
		await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);

		const byPrompt = (prompt: string) => requests().filter(r => r.users.at(-1) === prompt);
		for (const prompt of ["child continuation", "grandchild continuation"]) {
			const runs = byPrompt(prompt);
			assert.ok(runs.length > 1);
			assert.equal(runs[0].provider, "nested-test");
			assert.equal(runs[0].model, "nested-model");
			assert.deepEqual(runs[0].users, prompt === "child continuation" ? ["child initial", prompt] : ["grandchild prompt", prompt]);
			assert.match(runs[0].systemPrompt, prompt === "child continuation" ? /AGENT-BODY-CHILD/ : /AGENT-BODY-GRANDCHILD/);
			assert.match(runs[0].systemPrompt, /NESTED-SKILL-BODY/);
			for (const run of runs) {
				if (prompt === "child continuation") assert.match(run.systemPrompt, /ROOT-ONLY-SKILL-BODY/);
				else assert.doesNotMatch(run.systemPrompt, /ROOT-ONLY-SKILL-BODY/);
			}
			assert.doesNotMatch(runs[0].systemPrompt, /RELOADED-CHILD-BODY|RELOADED-DYNAMIC-BODY/);
			assert.ok(runs[0].tools.includes("delegate"));
			assert.ok(!runs[0].tools.includes("bash"));
			const final = runs.at(-1);
			assert.equal(final.turnResults.length, prompt === "child continuation" ? 4 : 3);
			assert.ok(final.turnResults.every((result: { isError: boolean }) => !result.isError), JSON.stringify(final.turnResults));
		}
		const resumedGrandchild = byPrompt("child continuation").at(-1).turnResults[0];
		assert.equal(resumedGrandchild.details?.sessionId, grandchildId);
		for (const origin of ["child", "grandchild"]) {
			for (const [agentName, provider, modelId, reasoning] of [
				["main", "alternate-test", "main", "high"],
				["dynamic", "alternate-test", "switch-target", "medium"],
				["parent", "alternate-test", "parent", "low"],
			]) {
				const leaf = byPrompt(`${origin} ${agentName} leaf`);
				assert.equal(leaf.length, 1, `${origin} ${agentName}`);
				assert.equal(leaf[0].provider, provider);
				assert.equal(leaf[0].model, modelId);
				assert.equal(leaf[0].reasoning, reasoning);
				assert.match(leaf[0].systemPrompt, new RegExp(`${agentName.toUpperCase()}-AGENT-BODY`));
				assert.doesNotMatch(leaf[0].systemPrompt, /RELOADED-DYNAMIC-BODY|AGENT-BODY-CHILD|AGENT-BODY-GRANDCHILD|NESTED-SKILL-BODY|ROOT-ONLY-SKILL-BODY/);
				assert.ok(leaf[0].tools.includes("read"));
				assert.ok(!leaf[0].tools.includes("delegate"));
				assert.ok(!leaf[0].tools.includes("bash"));
			}
		}

		const selectedModelFailure = (await harness.execute(ctx, { title: "No request fallback", input: "fail after selection", agent: "no-request-fallback" })).details as DelegateCmdResult;
		assert.equal(selectedModelFailure.status, "failed");
		assert.match(selectedModelFailure.error!, /intentional selected model failure/);
		const failedSelectedRequests = byPrompt("fail after selection");
		assert.equal(failedSelectedRequests.length, 1, "a request failure after selection is not retried with a later candidate");
		assert.equal(failedSelectedRequests[0].provider, "nested-test");
		assert.equal(failedSelectedRequests[0].model, "main");

		// A live root with no model must not fall back to the child's provider.
		Object.assign(ctx, { model: undefined });
		const missing = (await harness.execute(ctx, { title: "No root", input: "no root model", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(missing.status, "completed", JSON.stringify(missing));
		const noRootRuns = byPrompt("no root model");
		assert.match(noRootRuns[0].systemPrompt, /AGENT-BODY-CHILD/);
		assert.match(noRootRuns[0].systemPrompt, /NESTED-SKILL-BODY/);
		assert.match(noRootRuns[0].systemPrompt, /ROOT-ONLY-SKILL-BODY/);
		const noRootResults = noRootRuns.at(-1).turnResults;
		assert.equal(noRootResults.length, 4);
		assert.equal(noRootResults[0].isError, true);
		assert.match(JSON.stringify(noRootResults[0].content), /no root provider/);
		assert.equal(noRootResults[1].isError, true);
		assert.match(JSON.stringify(noRootResults[1].content), /no root provider/);
		assert.equal(noRootResults[2].isError, false);
		assert.equal(noRootResults[3].isError, false);
		assert.equal(byPrompt("must not run dynamic").length, 0);
		assert.equal(byPrompt("must not run main").length, 0);
		assert.equal(byPrompt("no root inherited leaf")[0].provider, "nested-test");
		assert.equal(byPrompt("no root fallback leaf")[0].provider, "alternate-test");
		assert.equal(byPrompt("no root fallback leaf")[0].model, "alternate-model");
		assert.equal(byPrompt("no root fallback leaf")[0].reasoning, "low");

		// Shutdown invalidates the old tree; a fresh factory acts as reload and
		// snapshots the replacement agent definitions rather than inheriting the old tree.
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		const closed = (await harness.execute(ctx, { title: "Closed", input: "closed", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(closed.status, "failed");
		assert.match(closed.error!, /root session is unavailable/i);
		Object.assign(ctx, { model: alternate, thinkingLevel: "high" });
		reloadedHarness = createExtensionHarness();
		reloadedHarness.beforeStart(ctx, ["delegate"], "base prompt", rootSkills);
		assert.equal(unavailableWarnings().length, 2, "a fresh root snapshot starts a new warning period");
		const stale = (await reloadedHarness.execute(ctx, { title: "Old ID", input: "stale", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(stale.status, "failed");
		assert.match(stale.error!, /unknown, expired, or cwd-mismatched/);
		const fresh = (await reloadedHarness.execute(ctx, { title: "Reloaded", input: "reload leaf", agent: "dynamic" })).details as DelegateCmdResult;
		assert.equal(fresh.status, "completed", JSON.stringify(fresh));
		assert.ok(fresh.sessionId);
		assert.notEqual(fresh.sessionId, initial.sessionId);
		const reloadedLeaf = byPrompt("reload leaf");
		assert.equal(reloadedLeaf.length, 1);
		assert.equal(reloadedLeaf[0].provider, "alternate-test");
		assert.equal(reloadedLeaf[0].model, "alternate-model");
		assert.equal(reloadedLeaf[0].reasoning, "low");
		assert.match(reloadedLeaf[0].systemPrompt, /RELOADED-DYNAMIC-BODY/);
		assert.doesNotMatch(reloadedLeaf[0].systemPrompt, /DYNAMIC-AGENT-BODY|NESTED-SKILL-BODY|ROOT-ONLY-SKILL-BODY/);
		assert.ok(!reloadedLeaf[0].tools.includes("delegate"));
		const freshChild = (await reloadedHarness.execute(ctx, { title: "Reloaded child", input: "reload child", agent: "child" })).details as DelegateCmdResult;
		assert.equal(freshChild.status, "completed", JSON.stringify(freshChild));
		const reloadedChild = byPrompt("reload child")[0];
		assert.match(reloadedChild.systemPrompt, /RELOADED-CHILD-BODY/);
		assert.doesNotMatch(reloadedChild.systemPrompt, /AGENT-BODY-CHILD|NESTED-SKILL-BODY|ROOT-ONLY-SKILL-BODY/);
		assert.ok(!reloadedChild.tools.includes("delegate"));
	} finally {
		if (reloadedHarness) await reloadedHarness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(rootDir, { recursive: true, force: true });
	}
});
