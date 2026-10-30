import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  for (const [provider, api, id] of [["nested-test", "nested-test-api", "nested-model"], ["alternate-test", "alternate-test-api", "alternate-model"]]) pi.registerProvider(provider, {
    baseUrl: "https://invalid.example", apiKey: "test-key", api,
    // Deliberately omit switch-target: it exists only in the root registry.
    models: [{ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.text || "").join(""));
      const results = context.messages.filter(m => m.role === "toolResult");
      const lastUserIndex = context.messages.findLastIndex(m => m.role === "user");
      const turnResults = context.messages.slice(lastUserIndex + 1).filter(m => m.role === "toolResult");
      log({ type: "request", provider: model.provider, model: model.id, reasoning: options?.reasoning, systemPrompt: context.systemPrompt, users, results, turnResults, tools: (context.tools || []).map(t => t.name) });
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      const prompt = users.at(-1);
      let args;
      if (prompt === "child initial" && turnResults.length === 0) args = { title: "Grandchild", input: "grandchild prompt" };
      if (prompt === "child continuation") {
        const grandchildId = results[0]?.details?.sessionId;
        const calls = [
          { title: "Resume grandchild", input: "grandchild continuation", continue_session: grandchildId },
          { title: "Child main", input: "child main leaf", agentPreset: "main" },
          { title: "Child dynamic", input: "child dynamic leaf", agentPreset: "dynamic" },
          { title: "Child parent", input: "child parent leaf", agentPreset: "parent" },
        ];
        args = calls[turnResults.length];
      }
      if (prompt === "grandchild continuation") {
        const calls = [
          { title: "Grandchild main", input: "grandchild main leaf", agentPreset: "main" },
          { title: "Grandchild dynamic", input: "grandchild dynamic leaf", agentPreset: "dynamic" },
          { title: "Grandchild parent", input: "grandchild parent leaf", agentPreset: "parent" },
        ];
        args = calls[turnResults.length];
      }
      if (prompt === "no root model") {
        const calls = [
          { title: "Missing provider", input: "must not run dynamic", agentPreset: "dynamic" },
          { title: "Missing main", input: "must not run main", agentPreset: "main" },
          { title: "Still parent", input: "no root parent leaf", agentPreset: "parent" },
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

test("existing child and grandchild resolve main and providerless presets from the live root", async () => {
	const rootDir = mkdtempSync(join(tmpdir(), "pi-nested-runtime-"));
	const agentDir = join(rootDir, "agent");
	const project = join(rootDir, "project");
	const logPath = join(rootDir, "provider.jsonl");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "subagent.json"), JSON.stringify({
		subagentPreamble: "NESTED-PREAMBLE-MARKER",
		agentPresets: {
			observer: { base: "parent", description: "Observer preset marker" },
			dynamic: { model: "switch-target", description: "Dynamic preset marker", thinkingLevel: "medium" },
		},
	}));
	writeFakeProvider(agentDir, logPath);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const harness = createExtensionHarness();
	const { ctx } = fakeContext(project);
	// Avoid UI rendering in the headless test.
	Object.defineProperty(ctx.ui, "theme", { value: undefined });
	try {
		// This registry supplies real model metadata to the root, but is not shared
		// with child sessions. Only the discovered extension supplies their stream.
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		registry.registerProvider("nested-test", {
			baseUrl: "https://invalid.example", apiKey: "test-key", api: "nested-test-api",
			models: [{ id: "nested-model", name: "Nested test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
		});
		registry.registerProvider("alternate-test", {
			baseUrl: "https://invalid.example", apiKey: "test-key", api: "alternate-test-api",
			models: ["alternate-model", "switch-target"].map(id => ({ id, name: id, reasoning: true, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 })),
		});
		const model = registry.find("nested-test", "nested-model");
		assert.ok(model);
		Object.assign(ctx, { model, modelRegistry: registry });
		const rootPrompt = harness.beforeStart(ctx, ["delegate"])?.systemPrompt;
		assert.match(rootPrompt!, /Observer preset marker/);
		assert.doesNotMatch(rootPrompt!, /NESTED-PREAMBLE-MARKER|Dynamic preset marker/);
		const records = () => readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const requests = () => records().filter(r => r.type === "request");
		const initial = (await harness.execute(ctx, { title: "Child", input: "child initial" })).details as DelegateCmdResult;
		assert.equal(initial.status, "completed", JSON.stringify(initial));
		assert.ok(initial.sessionId);
		assert.equal(initial.text, "child answer");
		const [child, grandchild, childAfterTool] = requests();
		assert.equal(records().filter(r => r.type === "factory").length, 2);
		for (const request of [child, grandchild]) {
			assert.equal(request.provider, "nested-test");
			assert.equal(request.model, "nested-model");
			assert.match(request.systemPrompt, /NESTED-PREAMBLE-MARKER/);
			assert.match(request.systemPrompt, /Observer preset marker/);
			assert.match(request.systemPrompt, /The main session model/);
			assert.doesNotMatch(request.systemPrompt, /Dynamic preset marker/);
			assert.ok(request.tools.includes("delegate"));
		}
		assert.deepEqual(grandchild.users, ["grandchild prompt"]);
		assert.equal(childAfterTool.results[0].isError, false);
		const grandchildId = childAfterTool.results[0].details?.sessionId;
		assert.ok(grandchildId);
		assert.notEqual(grandchildId, initial.sessionId);

		// Mutate the very same root context after both nested sessions exist.
		const alternate = registry.find("alternate-test", "alternate-model");
		assert.ok(alternate);
		Object.assign(ctx, { model: alternate, thinkingLevel: "high" });
		const continued = (await harness.execute(ctx, { title: "Continue", input: "child continuation", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(continued.status, "completed", JSON.stringify(continued));
		assert.equal(continued.sessionId, initial.sessionId);
		assert.equal(continued.text, "child continuation answer");

		const byPrompt = (prompt: string) => requests().filter(r => r.users.at(-1) === prompt);
		for (const prompt of ["child continuation", "grandchild continuation"]) {
			const runs = byPrompt(prompt);
			assert.ok(runs.length > 1);
			assert.equal(runs[0].provider, "nested-test");
			assert.equal(runs[0].model, "nested-model");
			assert.deepEqual(runs[0].users, prompt === "child continuation" ? ["child initial", prompt] : ["grandchild prompt", prompt]);
			assert.match(runs[0].systemPrompt, /The main session model/);
			assert.match(runs[0].systemPrompt, /Dynamic preset marker/);
			assert.match(runs[0].systemPrompt, /Observer preset marker/);
			assert.match(runs[0].systemPrompt, /NESTED-PREAMBLE-MARKER/);
			const final = runs.at(-1);
			assert.equal(final.turnResults.length, prompt === "child continuation" ? 4 : 3);
			assert.ok(final.turnResults.every((result: { isError: boolean }) => !result.isError), JSON.stringify(final.turnResults));
		}
		const resumedGrandchild = byPrompt("child continuation").at(-1).turnResults[0];
		assert.equal(resumedGrandchild.details?.sessionId, grandchildId);
		for (const origin of ["child", "grandchild"]) {
			for (const [preset, provider, modelId, reasoning] of [
				["main", "alternate-test", "alternate-model", "high"],
				["dynamic", "alternate-test", "switch-target", "medium"],
				["parent", "nested-test", "nested-model", "low"],
			]) {
				const leaf = byPrompt(`${origin} ${preset} leaf`);
				assert.equal(leaf.length, 1, `${origin} ${preset}`);
				assert.equal(leaf[0].provider, provider);
				assert.equal(leaf[0].model, modelId);
				assert.equal(leaf[0].reasoning, reasoning);
			}
		}

		// A live root with no model must not fall back to the child's provider.
		Object.assign(ctx, { model: undefined });
		const missing = (await harness.execute(ctx, { title: "No root", input: "no root model", continue_session: initial.sessionId })).details as DelegateCmdResult;
		assert.equal(missing.status, "completed", JSON.stringify(missing));
		const noRootRuns = byPrompt("no root model");
		assert.doesNotMatch(noRootRuns[0].systemPrompt, /Dynamic preset marker|The main session model/);
		assert.match(noRootRuns[0].systemPrompt, /Observer preset marker/);
		const noRootResults = noRootRuns.at(-1).turnResults;
		assert.equal(noRootResults.length, 3);
		assert.equal(noRootResults[0].isError, true);
		assert.match(JSON.stringify(noRootResults[0].content), /needs a provider because the root session has no active model/);
		assert.equal(noRootResults[1].isError, true);
		assert.match(JSON.stringify(noRootResults[1].content), /main session has no active model/);
		assert.equal(noRootResults[2].isError, false);
		assert.equal(byPrompt("must not run dynamic").length, 0);
		assert.equal(byPrompt("must not run main").length, 0);
		assert.equal(byPrompt("no root parent leaf")[0].provider, "nested-test");
	} finally {
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(rootDir, { recursive: true, force: true });
	}
});
