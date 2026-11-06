import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Api } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { DelegateCmdResult } from "../src/result.ts";

test("session reload refreshes captured agent definitions and Pi resources and invalidates child IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-reload-runtime-"));
	const cwd = join(root, "project"), agentDir = join(root, "agent");
	const agents = join(agentDir, "agents"), skills = join(agentDir, "skills"), prompts = join(agentDir, "prompts");
	const extraSkill = join(root, "extra-skill");
	for (const dir of [cwd, agents, join(skills, "visible"), join(skills, "hidden"), prompts, extraSkill, join(agentDir, "extensions")]) mkdirSync(dir, { recursive: true });
	// Children construct their own ModelRuntime and resource loader, so the fake
	// provider must be discoverable in both runtimes, not just registered inline.
	const providerLog = join(root, "provider.jsonl");
	const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	writeFileSync(join(agentDir, "extensions", "fake-provider.js"), `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from ${JSON.stringify(aiPath)};
export default function (pi) {
  pi.registerProvider("reload-fake", {
    baseUrl: "https://invalid.example", apiKey: "fake", api: "reload-fake-api",
    models: [{ id: "fake-model", name: "Fake", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const users = context.messages.filter(m => m.role === "user");
      const lastUser = users.at(-1);
      const prompt = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content || []).map(p => p.text || "").join("");
      const lastUserIndex = context.messages.findLastIndex(m => m.role === "user");
      const turnResults = context.messages.slice(lastUserIndex + 1).filter(m => m.role === "toolResult");
      appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify({ prompt, results: turnResults.length, systemPrompt: context.systemPrompt, reasoning: options?.reasoning }) + "\\n");
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      let args;
      if (!turnResults.length && prompt === "create child") args = { title: "Child", input: "child request", agent: "child" };
      if (!turnResults.length && prompt.startsWith("continue child ")) args = { title: "Continue", input: "child continuation", continue_session: prompt.slice("continue child ".length) };
      if (args) {
        const call = { type: "toolCall", id: "delegate-call", name: "delegate", arguments: args };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = "toolUse";
      } else {
        message.content.push({ type: "text", text: "ok" });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
`);
	const writeSkill = (dir: string, name: string, description: string, hidden = false) => writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${hidden ? "disable-model-invocation: true\n" : ""}---\nInstructions.\n`);
	writeSkill(join(skills, "visible"), "visible", "Old skill description");
	writeSkill(join(skills, "hidden"), "hidden", "Hidden skill description", true);
	writeSkill(extraSkill, "provided", "Provided by extension");
	const definition = join(agents, "example.md");
	const childDefinition = join(agents, "child.md");
	writeFileSync(definition, "---\nname: example\nold_field: true\nskills: { preload: [hidden, provided, old-missing] }\n---\nold body\n");
	writeFileSync(childDefinition, "---\nname: child\nmodel: { id: fake-model, thinkingLevel: low }\n---\nOLD-CHILD-BODY\n");
	writeFileSync(join(prompts, "review.md"), "Old template $1\n");
	writeFileSync(join(agentDir, "subagent.json"), "not valid JSON; ignored by the extension");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const warnings: string[] = [], errors: string[] = [];
	const before: Array<{ prompt: string; skills: Array<{ name: string; description: string; hidden: boolean }> }> = [];
	const lifecycle: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
	const model: Model<Api> = {
		id: "fake-model", name: "Fake", api: "reload-fake-api", provider: "reload-fake", baseUrl: "https://invalid.example",
		reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
	};
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const delegateResults: Array<{ details: DelegateCmdResult; isError: boolean }> = [];
	try {
		const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "always", retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			extensionFactories: [extension, (pi) => {
				pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
				pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
				pi.on("resources_discover", (event) => { lifecycle.push(`discover:${event.reason}`); return { skillPaths: [extraSkill] }; });
				pi.on("before_agent_start", (event) => {
					before.push({ prompt: event.prompt, skills: (event.systemPromptOptions.skills ?? []).map(s => ({ name: s.name, description: s.description, hidden: s.disableModelInvocation })) });
				});
			}],
		});
		await loader.reload();
		({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, model, sessionManager: SessionManager.inMemory(cwd) }));
		session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "delegate") {
				delegateResults.push({ details: event.result.details as DelegateCmdResult, isError: event.isError });
			}
		});
		await session.bindExtensions({ onError: (error) => { errors.push(`${error.event}: ${error.error}`); } });
		assert.deepEqual(lifecycle, ["start:startup", "discover:startup"]);
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.ok(loader.getSkills().skills.some(s => s.name === "provided"));
		assert.match(warnings.join("\n"), /old_field/);
		assert.doesNotMatch(warnings.join("\n"), /old-missing/, "preload catalog diagnostics wait until before_agent_start");

		// session_start captured agent files; no before_agent_start has run yet.
		writeFileSync(definition, "---\nname: example\nnew_field: true\nskills: { preload: [hidden, provided, new-missing] }\n---\nnew body\n");
		writeFileSync(childDefinition, "---\nname: child\nmodel: { id: fake-model, thinkingLevel: high }\n---\nNEW-CHILD-BODY\n");
		writeFileSync(join(agentDir, "subagent.json"), "still ignored after reload");
		writeSkill(join(skills, "visible"), "visible", "New skill description");
		writeFileSync(join(prompts, "review.md"), "New template $1\n");
		await session.prompt("/review first");
		assert.equal(session.getLastAssistantText(), "ok");
		assert.equal(before.length, 1);
		assert.match(before[0].prompt, /Old template first/);
		assert.equal(before[0].skills.find(s => s.name === "visible")?.description, "Old skill description");
		assert.equal(before[0].skills.find(s => s.name === "hidden")?.hidden, true);
		assert.ok(before[0].skills.some(s => s.name === "provided"));
		assert.match(warnings.join("\n"), /old_field/);
		assert.match(warnings.join("\n"), /old-missing/);
		assert.doesNotMatch(warnings.join("\n"), /new_field|new-missing|unknown preloaded skill.*(?:hidden|provided)/);
		assert.doesNotMatch(session.systemPrompt, /Hidden skill description/);

		// Create an actual child and prove the returned ID works before reload.
		await session.prompt("create child");
		assert.equal(delegateResults.length, 1);
		assert.equal(delegateResults[0].isError, false, JSON.stringify(delegateResults[0]));
		assert.equal(delegateResults[0].details.status, "completed");
		assert.equal(delegateResults[0].details.text, "ok");
		const childId = delegateResults[0].details.sessionId;
		assert.ok(childId);
		await session.prompt(`continue child ${childId}`);
		assert.equal(delegateResults.length, 2);
		assert.equal(delegateResults[1].isError, false, JSON.stringify(delegateResults[1]));
		assert.equal(delegateResults[1].details.status, "completed");
		assert.equal(delegateResults[1].details.sessionId, childId);
		assert.equal(delegateResults[1].details.text, "ok");
		await session.prompt("second");
		assert.equal(warnings.filter(s => s.includes("old_field")).length, 1);
		assert.doesNotMatch(warnings.join("\n"), /new_field|new-missing/);

		// This is the same public AgentSession.reload() used by Pi's interactive /reload.
		await session.reload();
		assert.deepEqual(lifecycle, ["start:startup", "discover:startup", "shutdown:reload", "start:reload", "discover:reload"]);
		assert.match(warnings.join("\n"), /new_field/);
		assert.doesNotMatch(warnings.join("\n"), /new-missing/, "reload preflight still defers catalog-dependent diagnostics");
		assert.equal(loader.getSkills().skills.find(s => s.name === "visible")?.description, "New skill description");
		assert.ok(loader.getSkills().skills.some(s => s.name === "provided"));
		await session.prompt("/review third");
		assert.equal(before.length, 5);
		assert.match(before[4].prompt, /New template third/);
		assert.equal(before[4].skills.find(s => s.name === "visible")?.description, "New skill description");
		assert.equal(before[4].skills.find(s => s.name === "hidden")?.hidden, true);
		assert.ok(before[4].skills.some(s => s.name === "provided"));
		assert.match(warnings.join("\n"), /new_field/);
		assert.match(warnings.join("\n"), /new-missing/);
		assert.doesNotMatch(warnings.join("\n"), /unknown preloaded skill.*(?:hidden|provided)/);

		await session.prompt(`continue child ${childId}`);
		assert.equal(delegateResults.length, 3);
		assert.equal(delegateResults[2].isError, true);
		assert.equal(delegateResults[2].details.status, "failed");
		assert.match(delegateResults[2].details.error!, /unknown, expired, or cwd-mismatched/i);
		await session.prompt("create child");
		assert.equal(delegateResults.length, 4);
		assert.equal(delegateResults[3].isError, false, JSON.stringify(delegateResults[3]));
		assert.equal(delegateResults[3].details.status, "completed");
		assert.ok(delegateResults[3].details.sessionId);
		assert.notEqual(delegateResults[3].details.sessionId, childId);
		const requests = readFileSync(providerLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as { prompt: string; results: number; systemPrompt: string; reasoning?: string });
		const childRequests = requests.filter(r => r.prompt === "child request");
		assert.equal(childRequests.length, 2);
		assert.match(childRequests[0].systemPrompt, /OLD-CHILD-BODY/);
		assert.doesNotMatch(childRequests[0].systemPrompt, /NEW-CHILD-BODY/);
		assert.equal(childRequests[0].reasoning, "low");
		assert.match(childRequests[1].systemPrompt, /NEW-CHILD-BODY/);
		assert.doesNotMatch(childRequests[1].systemPrompt, /OLD-CHILD-BODY/);
		assert.equal(childRequests[1].reasoning, "high");
		const continuations = requests.filter(r => r.prompt === "child continuation");
		assert.equal(continuations.length, 1, "stale continuation must not reach the child provider");
		assert.match(continuations[0].systemPrompt, /OLD-CHILD-BODY/);
		assert.doesNotMatch(continuations[0].systemPrompt, /NEW-CHILD-BODY/);
		assert.deepEqual(errors, []);
		assert.doesNotMatch(warnings.join("\n"), /subagent\.json|pi-subagent configuration/i);
	} finally {
		// The test may leave a child open even after the tested reload. Reload emits
		// session_shutdown and closes children; dispose() alone does not.
		if (session) await session.reload().catch(() => {});
		session?.dispose();
		console.warn = originalWarn;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
