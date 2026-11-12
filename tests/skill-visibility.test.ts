import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, ModelRegistry, ModelRuntime, type Skill } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, fakeContext } from "./extension-harness.ts";
import type { DelegateCmdResult } from "../src/result.ts";

// Every child (including descendants) discovers its own network-free provider.
function writeProvider(agentDir: string, logPath: string, discoveredSkillPath: string) {
	const aiPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	const typeboxPath = fileURLToPath(import.meta.resolve("typebox"));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "visibility-provider.js"), `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getSystemMessageText } from ${JSON.stringify(aiPath)};
import { Type } from ${JSON.stringify(typeboxPath)};
export default function (pi) {
  const lifecycle = (event, ctx) => appendFileSync(${JSON.stringify(logPath + ".lifecycle")}, JSON.stringify({ type: event.type, reason: event.reason, id: ctx.sessionManager.getSessionId() }) + "\\n");
  pi.on("session_start", (event, ctx) => {
    lifecycle(event, ctx);
    pi.registerTool({
      name: "late-tool", label: "Late tool", description: "Registered during session startup",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "late" }], details: {} }; }
    });
  });
  pi.on("resources_discover", (event, ctx) => {
    lifecycle(event, ctx);
    return { skillPaths: [${JSON.stringify(discoveredSkillPath)}] };
  });
  pi.on("session_shutdown", lifecycle);
  pi.registerProvider("visibility-test", {
    baseUrl: "https://invalid.example", apiKey: "test-key", api: "visibility-test-api",
    models: [{ id: "visibility-model", name: "Visibility test", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.text || "").join(""));
      const lastUserIndex = context.messages.findLastIndex(m => m.role === "user");
      const results = context.messages.slice(lastUserIndex + 1).filter(m => m.role === "toolResult");
      const systemMessage = context.messages.find(m => m.role === "system");
      const systemPrompt = context.systemPrompt ?? (systemMessage ? getSystemMessageText(systemMessage) : "");
      const activeTools = new Map();
      for (const entry of context.messages) if (entry.role === "system") {
        for (const tool of entry.toolsRemoved || []) activeTools.delete(tool.name);
        for (const tool of entry.toolsAdded || []) activeTools.set(tool.name, tool);
      }
      const tools = context.tools ? context.tools.map(t => t.name) : [...activeTools.keys()];
      appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ systemPrompt, users, results, tools }) + "\\n");
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      const prompt = users.at(-1);
      const agent = prompt === "spawn private" ? "private" : prompt === "spawn public" ? "public" : undefined;
      if (agent && results.length === 0) {
        const call = { type: "toolCall", id: "visibility-call", name: "delegate", arguments: { title: "Descendant", input: "descendant " + agent, new_agent: agent } };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = "toolUse";
      } else {
        message.content.push({ type: "text", text: "done" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: message });
        message.stopReason = "stop";
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    }
  });
}`);
}

type Request = { systemPrompt: string; users: string[]; results: { isError: boolean; details?: { sessionId?: string } }[]; tools: string[] };
type LifecycleEvent = { type: string; reason: string; id: string };

function catalog(prompt: string): string {
	return prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0] ?? "";
}

function assertOrdinaryCatalog(prompt: string) {
	const section = catalog(prompt);
	assert.match(section, /<name>preloaded<\/name>/);
	assert.match(section, /<name>other<\/name>/);
	assert.match(section, /OTHER-CATALOG-DESCRIPTION/);
	assert.doesNotMatch(section, /<name>hidden<\/name>|HIDDEN-CATALOG-DESCRIPTION/);
}

function assertNoCatalog(prompt: string) {
	assert.equal(catalog(prompt), "");
	assert.doesNotMatch(prompt, /OTHER-CATALOG-DESCRIPTION|HIDDEN-CATALOG-DESCRIPTION|EXTENSION-CATALOG-DESCRIPTION/);
}

test("real child skill visibility, explicit expansion, descendants and reload", async (t) => {
	const rootDir = mkdtempSync(join(tmpdir(), "pi-skill-visibility-"));
	const agentDir = join(rootDir, "agent");
	const project = join(rootDir, "project");
	const logPath = join(rootDir, "provider.jsonl");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	const rootSkills: Skill[] = [];
	for (const [name, description, body, hidden] of [
		["preloaded", "PRELOADED-CATALOG-DESCRIPTION", "PRELOADED-SKILL-BODY", false],
		["other", "OTHER-CATALOG-DESCRIPTION", "OTHER-SKILL-BODY", false],
		["hidden", "HIDDEN-CATALOG-DESCRIPTION", "HIDDEN-SKILL-BODY", true],
	] as const) {
		const baseDir = join(agentDir, "skills", name);
		mkdirSync(baseDir, { recursive: true });
		const filePath = join(baseDir, "SKILL.md");
		writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n${hidden ? "disable-model-invocation: true\n" : ""}---\n${body}\n`);
		// The fake root does not discover resources; real children discover these files.
		rootSkills.push({ name, description, filePath, baseDir, disableModelInvocation: hidden } as Skill);
	}
	// Outside all default skill roots: only resources_discover makes this visible
	// to a real child. The fake root is supplied the corresponding full catalog.
	const extensionSkillDir = join(rootDir, "extension-resource");
	mkdirSync(extensionSkillDir, { recursive: true });
	const extensionSkillPath = join(extensionSkillDir, "SKILL.md");
	writeFileSync(extensionSkillPath, "---\nname: extension-skill\ndescription: EXTENSION-CATALOG-DESCRIPTION\n---\nEXTENSION-SKILL-BODY\n");
	rootSkills.push({ name: "extension-skill", description: "EXTENSION-CATALOG-DESCRIPTION", filePath: extensionSkillPath, baseDir: extensionSkillDir, disableModelInvocation: false } as Skill);
	const putAgent = (name: string, skills: string) => writeFileSync(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name.toUpperCase()}-AGENT-DESCRIPTION\n${skills}---\n${name.toUpperCase()}-AGENT-BODY\n`);
	putAgent("private", "skills:\n  allowDiscovery: false\n  preload: [preloaded]\n");
	putAgent("public", "skills:\n  allowDiscovery: true\n");
	putAgent("default", "");
	putAgent("quiet", "tools:\n  '*': false\n  read: true\n  late-tool: false\n");
	writeProvider(agentDir, logPath, extensionSkillPath);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const harness = createExtensionHarness();
	let reloaded: ReturnType<typeof createExtensionHarness> | undefined;
	const { ctx } = fakeContext(project);
	Object.defineProperty(ctx.ui, "theme", { value: undefined });
	try {
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		registry.registerProvider("visibility-test", {
			baseUrl: "https://invalid.example", apiKey: "test-key", api: "visibility-test-api",
			models: [{ id: "visibility-model", name: "Visibility test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
		});
		const model = registry.find("visibility-test", "visibility-model");
		assert.ok(model);
		Object.assign(ctx, { model, modelRegistry: registry });
		harness.beforeStart(ctx, ["delegate"], "base prompt", rootSkills);
		const openedIds: string[] = [];
		const run = async (active: typeof harness, input: string, newAgentOrId: { new_agent: string } | { continue_session: string }) => {
			const result = (await active.execute(ctx, { title: "Visibility", input, ...newAgentOrId })).details as DelegateCmdResult;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.ok(result.sessionId);
			if ("new_agent" in newAgentOrId) openedIds.push(result.sessionId);
			return result.sessionId;
		};
		const privateId = await run(harness, "private initial", { new_agent: "private" });
		assert.equal(await run(harness, "/skill:other use it explicitly", { continue_session: privateId }), privateId);
		assert.equal(await run(harness, "/skill:hidden hidden arguments", { continue_session: privateId }), privateId);
		assert.equal(await run(harness, "/skill:extension-skill extension arguments", { continue_session: privateId }), privateId);
		await run(harness, "public initial", { new_agent: "public" });
		await run(harness, "quiet initial", { new_agent: "quiet" });
		await run(harness, "default initial", { new_agent: "default" });
		const spawnPrivateId = await run(harness, "spawn private", { new_agent: "public" });
		const spawnPublicId = await run(harness, "spawn public", { new_agent: "private" });

		// A new child still uses the captured definition until the root is reloaded.
		putAgent("private", "skills:\n  allowDiscovery: true\n  preload: [preloaded]\n");
		await run(harness, "before reload", { new_agent: "private" });
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		reloaded = createExtensionHarness();
		reloaded.beforeStart(ctx, ["delegate"], "base prompt", rootSkills);
		await run(reloaded, "after reload", { new_agent: "private" });
		await reloaded.emit("session_shutdown", { type: "session_shutdown" }, ctx);

		const records: Request[] = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const request = (input: string) => {
			const found = records.find(record => record.users.at(-1) === input);
			assert.ok(found, `missing request ${input}`);
			return found;
		};
		const expanded = (name: string) => {
			const found = records.find(record => record.users.at(-1)?.startsWith(`<skill name="${name}"`));
			assert.ok(found, `missing expanded ${name} request`);
			return found;
		};
		await t.test("false hides catalog but preloads body on initial and continued turns", () => {
			for (const run of [request("private initial"), expanded("other"), expanded("hidden")]) {
				assertNoCatalog(run.systemPrompt);
				assert.match(run.systemPrompt, /PRELOADED-SKILL-BODY/);
				assert.doesNotMatch(run.systemPrompt, /OTHER-SKILL-BODY|HIDDEN-SKILL-BODY|EXTENSION-SKILL-BODY/);
			}
		});
		await t.test("continuations expand both ordinary and normally hidden skills", () => {
			const other = expanded("other");
			assert.deepEqual(other.users.slice(0, 1), ["private initial"]);
			assert.match(other.users.at(-1)!, /OTHER-SKILL-BODY[\s\S]*<\/skill>[\s\S]*use it explicitly/);
			const hidden = expanded("hidden");
			assert.match(hidden.users.at(-1)!, /HIDDEN-SKILL-BODY[\s\S]*<\/skill>[\s\S]*hidden arguments/);
		});
		await t.test("extension-discovered skill is visible publicly and explicitly expandable privately", () => {
			const publicCatalog = catalog(request("public initial").systemPrompt);
			assert.match(publicCatalog, /<name>extension-skill<\/name>/);
			assert.match(publicCatalog, /EXTENSION-CATALOG-DESCRIPTION/);
			const extension = expanded("extension-skill");
			assertNoCatalog(extension.systemPrompt);
			assert.match(extension.systemPrompt, /PRELOADED-SKILL-BODY/);
			assert.match(extension.users.at(-1)!, /EXTENSION-SKILL-BODY[\s\S]*<\/skill>[\s\S]*extension arguments/);
		});
		await t.test("true and default retain ordinary Pi catalog behavior", () => {
			for (const input of ["public initial", "default initial"]) assertOrdinaryCatalog(request(input).systemPrompt);
		});
		await t.test("digest appears only with delegate active and contains no bodies or source paths", () => {
			for (const run of [request("private initial"), expanded("other"), request("public initial"), request("descendant private"), request("descendant public")]) {
				assert.ok(run.tools.includes("delegate"));
				const digest = run.systemPrompt.match(/<delegate_agent_options>[\s\S]*?<\/delegate_agent_options>/)?.[0];
				assert.ok(digest, "missing agent digest");
				for (const name of ["private", "public", "default", "quiet"]) {
					assert.ok(digest.includes(name), `missing agent ${name}`);
					assert.ok(digest.includes(`${name.toUpperCase()}-AGENT-DESCRIPTION`));
					assert.ok(!digest.includes(`${name.toUpperCase()}-AGENT-BODY`));
					assert.ok(!digest.includes(join(agentDir, "agents", `${name}.md`)));
				}
				assert.doesNotMatch(digest, /(?:^|[\\/])agents[\\/]|\.md\b/);
			}
			const quiet = request("quiet initial");
			assert.ok(!quiet.tools.includes("delegate"));
			assert.doesNotMatch(quiet.systemPrompt, /<delegate_agent_options>|PRIVATE-AGENT-DESCRIPTION|PUBLIC-AGENT-DESCRIPTION/);
			assert.match(quiet.systemPrompt, /QUIET-AGENT-BODY/);
		});
		await t.test("startup-registered tools obey agent rules", () => {
			const quiet = request("quiet initial");
			assert.ok(quiet.tools.includes("read"));
			assert.ok(!quiet.tools.includes("late-tool"));
			assert.ok(request("public initial").tools.includes("late-tool"));
		});
		await t.test("each descendant uses its own agent policy", () => {
			assertOrdinaryCatalog(request("spawn private").systemPrompt);
			assertNoCatalog(request("descendant private").systemPrompt);
			assert.match(request("descendant private").systemPrompt, /PRELOADED-SKILL-BODY/);
			assertNoCatalog(request("spawn public").systemPrompt);
			assertOrdinaryCatalog(request("descendant public").systemPrompt);
			for (const input of ["spawn private", "spawn public"]) {
				const afterTool = records.filter(record => record.users.at(-1) === input).at(-1)!;
				assert.equal(afterTool.results.length, 1);
				assert.equal(afterTool.results[0].isError, false);
			}
		});
		await t.test("each child and descendant receives ordered startup, discovery and shutdown", () => {
			const lifecycle: LifecycleEvent[] = readFileSync(logPath + ".lifecycle", "utf8").trim().split("\n").map(line => JSON.parse(line));
			const descendant = (prompt: string) => {
				const afterTool = records.filter(record => record.users.at(-1) === prompt).at(-1)!;
				const id = afterTool.results[0]?.details?.sessionId;
				assert.ok(id, `missing descendant ID for ${prompt}`);
				return id;
			};
			const descendantPrivateId = descendant("spawn private");
			const descendantPublicId = descendant("spawn public");
			const allIds = [...openedIds, descendantPrivateId, descendantPublicId];
			assert.equal(new Set(allIds).size, 10);
			assert.deepEqual(new Set(lifecycle.map(event => event.id)), new Set(allIds));
			for (const id of allIds) {
				assert.deepEqual(lifecycle.filter(event => event.id === id).map(({ type, reason }) => ({ type, reason })), [
					{ type: "session_start", reason: "startup" },
					{ type: "resources_discover", reason: "startup" },
					{ type: "session_shutdown", reason: "quit" },
				], `lifecycle for ${id}`);
			}
			for (const [parentId, childId] of [[spawnPrivateId, descendantPrivateId], [spawnPublicId, descendantPublicId]]) {
				const shutdownIndex = (id: string) => lifecycle.findIndex(event => event.id === id && event.type === "session_shutdown");
				assert.ok(shutdownIndex(childId) < shutdownIndex(parentId), "descendant should shut down before its parent");
			}
		});
		await t.test("snapshot retains policy until reload", () => {
			assertNoCatalog(request("before reload").systemPrompt);
			assertOrdinaryCatalog(request("after reload").systemPrompt);
			assert.match(request("after reload").systemPrompt, /PRELOADED-SKILL-BODY/);
		});
	} finally {
		if (reloaded) await reloaded.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		await harness.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(rootDir, { recursive: true, force: true });
	}
});
