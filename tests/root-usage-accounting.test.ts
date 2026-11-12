import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import registerExtension from "../src/index.ts";

function writeProvider(agentDir: string) {
	const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	writeFileSync(join(agentDir, "extensions", "usage-provider.js"), `
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
export default function (pi) {
  pi.registerProvider("usage-test", {
    baseUrl: "https://invalid.example", apiKey: "test-key", api: "usage-test-api",
    models: [{ id: "usage-model", name: "Usage test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(message => message.role === "user");
      const prompt = users.at(-1)?.content;
      const text = typeof prompt === "string" ? prompt : (prompt || []).map(part => part.text || "").join("");
      const lastUserIndex = context.messages.findLastIndex(message => message.role === "user");
      const turnResults = context.messages.slice(lastUserIndex + 1).filter(message => message.role === "toolResult");
      const role = text.startsWith("worker") ? "worker" : text.startsWith("leaf") ? "leaf" : "root";
      let call;
      let answer;
      let cost = 0;
      if (role === "root" && text === "root initial" && turnResults.length === 0) {
        call = { new_agent: "worker", input: "worker initial", title: "Worker initial" };
      } else if (role === "root" && text === "root continue" && turnResults.length === 0) {
        const prior = context.messages.filter(message => message.role === "toolResult" && message.toolName === "delegate").at(-1);
        if (!prior?.details?.sessionId) throw new Error("previous delegate result did not include a session ID");
        call = { continue_session: prior.details.sessionId, input: "worker continuation", title: "Worker continuation" };
      } else if (role === "worker" && text === "worker initial" && turnResults.length === 0) {
        call = { new_agent: "leaf", input: "leaf initial", title: "Leaf initial" };
        cost = 2;
      } else if (role === "worker" && text === "worker continuation") {
        answer = "worker continued";
        cost = 11;
      } else if (role === "worker") {
        answer = "worker completed";
        cost = 4;
      } else if (role === "leaf") {
        answer = "leaf completed";
        cost = 3;
      } else {
        answer = text + " completed";
      }
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: cost,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
        stopReason: "pending", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      if (call) {
        const toolCall = { type: "toolCall", id: "usage-call-" + Date.now(), name: "delegate", arguments: call };
        message.content.push(toolCall);
        message.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      } else {
        message.content.push({ type: "text", text: answer });
        message.stopReason = "stop";
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: answer, partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
`);
}

test("root AgentSession stats include nested delegation usage once and continuation deltas only", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-root-usage-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ntools:\n  '*': false\n  delegate: true\n---\nWORKER-BODY\n");
	writeFileSync(join(agentDir, "agents", "leaf.md"), "---\nname: leaf\ntools:\n  '*': false\n---\nLEAF-BODY\n");
	writeProvider(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "always", retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [registerExtension] });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const model: Model<Api> = {
			provider: "usage-test", id: "usage-model", name: "Usage test", api: "usage-test-api",
			baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
		};
		({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, model, sessionManager: SessionManager.inMemory(cwd) }));
		await session.bindExtensions({ mode: "print" });
		const delegateResults = () => session!.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "delegate") return [];
			return [entry.message];
		});

		const beforeInitial = session.getSessionStats().cost;
		await session.prompt("root initial");
		const firstDelegateResult = delegateResults().at(-1);
		assert.ok(firstDelegateResult?.usage, "root persisted the delegate AgentToolResult.usage");
		assert.equal(firstDelegateResult.usage.cost.total, 9, "worker usage (2 + 4) includes the nested leaf usage (3) exactly once");
		assert.equal(session.getSessionStats().cost - beforeInitial, firstDelegateResult.usage.cost.total);

		const beforeContinuation = session.getSessionStats().cost;
		await session.prompt("root continue");
		const continuedDelegateResult = delegateResults().at(-1);
		assert.ok(continuedDelegateResult?.usage, "continued root result carries its delegate usage");
		assert.equal(continuedDelegateResult.usage.cost.total, 11);
		assert.equal(session.getSessionStats().cost - beforeContinuation, continuedDelegateResult.usage.cost.total,
			"the ROOT session stats increase only by the new continuation delta");
		assert.equal(session.getSessionStats().cost, firstDelegateResult.usage.cost.total + continuedDelegateResult.usage.cost.total);
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
			session.dispose();
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
