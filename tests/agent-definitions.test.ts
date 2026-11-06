import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSnapshot, captureAgentSources, discoverAgentSnapshot, preflightAgentSources } from "../src/agent-definitions.ts";
import { evaluateToolAccess } from "../src/tool-access.ts";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

function fixture(run: (f: { dirs: { project: string; user: string }; put: (scope: "project" | "user", file: string, text: string) => string; capture: (trusted?: boolean) => ReturnType<typeof captureAgentSources>; discover: (trusted?: boolean, skills?: string[]) => ReturnType<typeof discoverAgentSnapshot> }) => void) {
	const root = mkdtempSync(join(tmpdir(), "agent-definitions-"));
	const cwd = join(root, "project"), agentDir = join(root, "user");
	const dirs = { project: join(cwd, CONFIG_DIR_NAME, "agents"), user: join(agentDir, "agents") };
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
	try {
		run({ dirs, put(scope, file, text) { const path = join(dirs[scope], file); writeFileSync(path, text); return path; }, capture(trusted = true) { return captureAgentSources({ cwd, agentDir, trusted }); }, discover(trusted = true, skillNames = []) { return discoverAgentSnapshot({ cwd, agentDir, trusted, skillNames }); } });
	} finally { rmSync(root, { recursive: true, force: true }); }
}
const agent = (name: string, more = "", body = "") => `---\nname: ${name}\n${more}---\n${body}`;

test("trust, lexical order, duplicates, invalid project fallback and no ancestor search", () => fixture(({ put, discover }) => {
	put("project", "z.md", agent("dup", "description: later\n"));
	put("project", "a.md", agent("dup", "description: first\n"));
	put("project", "bad.md", agent("fallback", "tools: [read]\n"));
	put("user", "b.md", agent("fallback"));
	put("user", "a.md", agent("dup"));
	put("user", "ignored.txt", agent("other"));
	const trusted = discover();
	assert.deepEqual(trusted.definitions.map((d) => [d.name, d.description]), [["dup", "first"], ["fallback", undefined]]);
	assert.equal(trusted.diagnostics.length, 3);
	assert.match(trusted.diagnostics[0].reason, /tools/);
	assert.match(trusted.diagnostics[1].reason, /duplicate/);
	assert.match(trusted.diagnostics[2].reason, /duplicate/);
	assert.deepEqual(discover(false).definitions.map((d) => d.name), ["dup", "fallback"]);
	assert.deepEqual(discover(false).diagnostics, []);
}));

test("model candidates normalize and candidate thinking levels are validated", () => fixture(({ put, discover }) => {
	put("user", "a.md", agent("a", "model: ' review '\n"));
	put("user", "b.md", agent("b", "model: { id: unavailable-id, provider: missing-provider, thinkingLevel: high }\n"));
	put("user", "c.md", agent("c", "model:\n  - ' parent '\n  - id: 'Models/Main'\n    provider: ' Provider/Name '\n    thinkingLevel: xhigh\n"));
	put("user", "d.md", agent("d", "model: [first, ' second ']\n"));
	put("user", "e.md", agent("e", "model:\n  - { id: off, thinkingLevel: off }\n  - { id: minimal, thinkingLevel: minimal }\n  - { id: low, thinkingLevel: low }\n  - { id: medium, thinkingLevel: medium }\n  - { id: high, thinkingLevel: high }\n  - { id: xhigh, thinkingLevel: xhigh }\n  - { id: max, thinkingLevel: max }\n"));
	put("user", "f.md", agent("f", "model: x\nprovider: p\n"));
	put("user", "g.md", agent("g", "provider: p\n"));
	put("user", "h.md", agent("h", "thinkingLevel: high\n"));
	put("user", "i.md", agent("i", "model: review\nthinkingLevel: high\n"));
	const snapshot = discover();
	assert.deepEqual(snapshot.definitions.map((d) => d.model), [
		[{ id: "review" }],
		[{ id: "unavailable-id", provider: "missing-provider", thinkingLevel: "high" }],
		[{ id: "parent" }, { id: "Models/Main", provider: "Provider/Name", thinkingLevel: "xhigh" }],
		[{ id: "first" }, { id: "second" }],
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id, thinkingLevel: id })),
	]);
	assert.equal(snapshot.diagnostics.length, 4);
	assert.equal(snapshot.diagnostics.filter(({ reason }) => /top-level provider is no longer supported/.test(reason)).length, 2);
	const thinkingDiagnostics = snapshot.diagnostics.filter(({ reason }) => /top-level thinkingLevel/.test(reason));
	assert.equal(thinkingDiagnostics.length, 2);
	assert.ok(thinkingDiagnostics.every(({ reason }) => /migrate model: x \+ thinkingLevel: high to model: \{ id: x, thinkingLevel: high \}/.test(reason)));
	assert.ok(thinkingDiagnostics.every(({ reason }) => /model is omitted.*inherited unchanged/.test(reason)));
}));

test("preflight reports safe structural diagnostics and defers catalog-dependent winner decisions", () => {
	const safeDuplicate = preflightAgentSources({ sources: [
		{ filename: "first.md", content: "---\nname: duplicate\nmodel: first-model\n---\n" },
		{ filename: "second.md", content: "---\nname: duplicate\nmodel: second-model\n---\n" },
	] });
	assert.deepEqual(safeDuplicate.modelDefinitions.map(({ filename }) => filename), ["first.md"]);
	assert.deepEqual(safeDuplicate.diagnostics, [{ filename: "second.md", reason: 'duplicate agent name "duplicate" (ignored)' }]);

	const uniqueCatalogDependent = preflightAgentSources({ sources: [
		{ filename: "unique.md", content: "---\nname: unique\nmodel: unique-model\nskills: { preload: [missing] }\n---\n" },
	] });
	assert.deepEqual(uniqueCatalogDependent.modelDefinitions.map(({ filename }) => filename), ["unique.md"]);
	assert.deepEqual(uniqueCatalogDependent.diagnostics, []);

	const catalogDependent = { sources: [
		{ filename: "project.md", content: "---\nname: shared\nmodel: project-model\nskills: { preload: [missing] }\n---\n" },
		{ filename: "user.md", content: "---\nname: shared\nmodel: user-model\n---\n" },
	] };
	const early = preflightAgentSources(catalogDependent);
	assert.deepEqual(early.diagnostics, []);
	assert.deepEqual(early.modelDefinitions, []);
	const final = buildAgentSnapshot(catalogDependent, []);
	assert.deepEqual(final.definitions.map(({ filename }) => filename), ["user.md"]);
	assert.deepEqual(final.diagnostics, [{ filename: "project.md", reason: 'unknown preloaded skill "missing"' }]);
});

test("unknown fields reported and ignored, nested skills and preload validated against full catalog", () => fixture(({ put, discover }) => {
	const path = put("user", "a.md", agent("test", "mystery: true\nskills:\n  allowDiscovery: false\n  preload: [one, two]\n  future: x\n"));
	put("user", "b.md", agent("bad", "skills: { preload: [missing] }\n"));
	const snapshot = discover(true, ["one", "two"]);
	assert.deepEqual(snapshot.definitions[0].skills, { allowDiscovery: false, preload: ["one", "two"] });
	assert.equal(snapshot.diagnostics.length, 3);
	assert.equal(snapshot.diagnostics[0].filename, path);
	assert.match(snapshot.diagnostics[0].reason, /mystery/);
	assert.match(snapshot.diagnostics[1].reason, /future/);
	assert.match(snapshot.diagnostics[2].reason, /missing/);
}));

test("invalid known fields and malformed YAML or delimiters are rejected", () => fixture(({ put, discover }) => {
	const invalid = [
		"name: ''", "name: [foo]", "name: ok\ndescription: [x]", "name: ok\ndescription: |\n  line\n  line", "name: ok\nmodel: null", "name: ok\nmodel: []", "name: ok\nmodel: [42]", "name: ok\nmodel: [null]", "name: ok\nmodel: [' ']", "name: ok\nmodel:\n  - { id: valid }\n  - { provider: p }", "name: ok\nmodel:\n  - { id: valid }\n  - false", "name: ok\nmodel: { provider: p }", "name: ok\nmodel: { id: x, alias: y }", "name: ok\nmodel: { id: x, thinkingLevel: extreme }", "name: ok\nmodel:\n  - { id: valid }\n  - { id: later, thinkingLevel: extreme }", "name: ok\nprovider: 3", "name: ok\ntools: { a: yes }", "name: ok\ntools: { '': true }", "name: ok\nskills: []", "name: ok\nskills: { allowDiscovery: null }", "name: ok\nskills: { preload: name }", "name: ok\nskills: { preload: [42] }", "name: ok\nname: duplicate", "name: [unterminated", "[a, b]",
	];
	invalid.forEach((yaml, i) => put("user", `${String(i).padStart(2, "0")}.md`, `---\n${yaml}\n---\n`));
	for (const [i, text] of ["name: no frontmatter", "---oops\nname: x\n---", "---\nname: x", "---\nname: x\n---oops\n", "--- \nname: x\n---"].entries()) put("user", `x${i}.md`, text);
	const snapshot = discover();
	assert.equal(snapshot.definitions.length, 0);
	assert.equal(snapshot.diagnostics.length, invalid.length + 5);
	assert.ok(snapshot.diagnostics.every((d) => d.filename.endsWith(".md") && d.reason.length > 0));
	assert.match(snapshot.diagnostics.find((d) => d.reason.includes("top-level provider"))?.reason ?? "", /migrate model: x \+ provider: p to model: \{ id: x, provider: p \}/);
}));

test("YAML quoting, flow and aliases, ordered tool patterns including __proto__, body and CRLF", () => fixture(({ put, discover }) => {
	put("user", "a.md", "---\r\nname: ' yaml '\r\ndescription: \"A: purpose\"\r\ntools: { read: false, '*': true, __proto__: false, bash: false }\r\nskills: { preload: &names [one], allowDiscovery: false, other: *names }\r\nmodel: { id: ' Models/Review ', thinkingLevel: xhigh }\r\n---\r\n\r\nBody\r\nline\r\n");
	const snapshot = discover(true, ["one"]);
	assert.equal(snapshot.definitions[0].name, "yaml");
	assert.equal(snapshot.definitions[0].prompt, "Body\nline");
	assert.deepEqual(snapshot.definitions[0].model, [{ id: "Models/Review", thinkingLevel: "xhigh" }]);
	assert.deepEqual(snapshot.definitions[0].tools, [{ pattern: "read", enabled: false }, { pattern: "*", enabled: true }, { pattern: "__proto__", enabled: false }, { pattern: "bash", enabled: false }]);
	assert.deepEqual(evaluateToolAccess(snapshot.definitions[0].tools, ["read", "bash", "__proto__"]), ["read"]);
	assert.match(snapshot.diagnostics[0].reason, /other/);
}));

test("mapping aliases preserve ordinary tool declaration order", () => fixture(({ put, discover }) => {
	put("user", "a.md", "---\nname: aliases\nrules: &rules\n  '*': false\n  read: true\n  bash: false\ntools: *rules\n---\nbody\n");
	const snapshot = discover();
	assert.deepEqual(snapshot.definitions[0].tools, [{ pattern: "*", enabled: false }, { pattern: "read", enabled: true }, { pattern: "bash", enabled: false }]);
	assert.deepEqual(evaluateToolAccess(snapshot.definitions[0].tools, ["read", "bash", "write"]), ["read"]);
	assert.equal(snapshot.definitions[0].prompt, "body");
	assert.match(snapshot.diagnostics[0].reason, /rules/);
}));

test("duplicate keys, nulls, sequences and bad aliases are rejected", () => fixture(({ put, discover }) => {
	const invalid = [
		"name: x\ntools: { read: true, read: false }",
		"name: x\nskills: { preload: [], preload: [] }",
		"name: x\ntools: null", "name: x\ntools: []", "name: x\ntools: !!set { read: null }", "name: x\nskills: null", "name: x\nskills: !!set { preload: null }",
		"name: x\ntools: *missing", "name: x\nother: *missing",
	];
	invalid.forEach((yaml, index) => put("user", `${index}.md`, `---\n${yaml}\n---\n`));
	const snapshot = discover();
	assert.equal(snapshot.definitions.length, 0);
	assert.equal(snapshot.diagnostics.filter((d) => !d.reason.includes("unknown frontmatter field")).length, invalid.length);
}));

test("capture freezes agent files; build applies skill names without rescanning", () => fixture(({ put, capture }) => {
	const project = put("project", "a.md", agent("shared", "model: review\nskills: { preload: [late] }\n", "project original"));
	const user = put("user", "b.md", agent("shared", "description: fallback\n", "user original"));
	const deleted = put("user", "c.md", agent("deleted", "", "still captured"));
	const captured = capture(true);
	assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.sources) && Object.isFrozen(captured.sources[0]));
	assert.throws(() => { (captured.sources as unknown[]).push({}); }, TypeError);
	put("project", "a.md", agent("changed"));
	rmSync(user);
	rmSync(deleted);
	put("project", "new.md", agent("new"));
	const withSkill = buildAgentSnapshot(captured, ["late"]);
	assert.deepEqual(withSkill.definitions.map((definition) => [definition.name, definition.prompt]), [["shared", "project original"], ["deleted", "still captured"]]);
	assert.deepEqual(withSkill.definitions[0].model, [{ id: "review" }]);
	assert.match(withSkill.diagnostics[0].reason, /duplicate/);
	assert.equal(withSkill.diagnostics[0].filename, user);
	const withoutSkill = buildAgentSnapshot(captured, []);
	assert.deepEqual(withoutSkill.definitions.map((definition) => [definition.name, definition.prompt]), [["shared", "user original"], ["deleted", "still captured"]]);
	assert.equal(withoutSkill.diagnostics[0].filename, project);
	assert.match(withoutSkill.diagnostics[0].reason, /unknown preloaded skill/);
	assert.deepEqual(buildAgentSnapshot(captured, ["late"]), withSkill);
	const fresh = buildAgentSnapshot(capture(true), ["late"]);
	assert.deepEqual(fresh.definitions.map((definition) => definition.name), ["changed", "new"]);
}));

test("read and directory failures retain their captured position among validation diagnostics", () => fixture(({ dirs, put, capture }) => {
	const invalid = put("project", "a.md", agent("bad", "tools: null\n"));
	const missing = join(dirs.project, "b.md");
	symlinkSync(join(dirs.project, "absent"), missing);
	const first = put("project", "c.md", agent("duplicate"));
	const duplicate = put("project", "d.md", agent("duplicate"));
	const user = put("user", "z.md", agent("user", "skills: { preload: [late] }\n"));
	const captured = capture();
	rmSync(missing);
	put("project", "b.md", agent("new-file"));
	const snapshot = buildAgentSnapshot(captured, []);
	assert.deepEqual(snapshot.definitions.map((definition) => definition.name), ["duplicate"]);
	assert.deepEqual(snapshot.diagnostics.map((item) => item.filename), [invalid, missing, duplicate, user]);
	assert.match(snapshot.diagnostics[0].reason, /tools/);
	assert.match(snapshot.diagnostics[1].reason, /ENOENT/);
	assert.match(snapshot.diagnostics[2].reason, /duplicate/);
	assert.match(snapshot.diagnostics[3].reason, /unknown preloaded skill/);
	assert.deepEqual(captured.sources.map((source) => source.filename), [invalid, missing, first, duplicate, user]);
	assert.ok(Object.isFrozen(captured.sources[1]));
	rmSync(dirs.project, { recursive: true });
	writeFileSync(dirs.project, "not a directory");
	const failedDirectory = capture();
	rmSync(dirs.project);
	mkdirSync(dirs.project);
	const built = buildAgentSnapshot(failedDirectory, ["late"]);
	assert.equal(built.diagnostics[0].filename, dirs.project);
	assert.match(built.diagnostics[0].reason, /could not read agents directory/);
	assert.deepEqual(built.definitions.map((definition) => definition.name), ["user"]);
}));

test("untrusted capture excludes project files even if later built after changes", () => fixture(({ put, capture }) => {
	put("project", "a.md", agent("shared", "description: project\n"));
	put("user", "a.md", agent("shared", "description: user\n"));
	const captured = capture(false);
	put("project", "b.md", agent("other"));
	const snapshot = buildAgentSnapshot(captured, []);
	assert.deepEqual(snapshot.definitions.map((definition) => [definition.name, definition.description]), [["shared", "user"]]);
	assert.deepEqual(snapshot.diagnostics, []);
	assert.equal(captured.sources.length, 1);
}));

test("snapshot is an immutable deep copy", () => fixture(({ put, discover }) => {
	put("user", "a.md", agent("a", "tools: { read: false }\nskills: { preload: [one] }\n"));
	const snapshot = discover(true, ["one"]);
	assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.definitions) && Object.isFrozen(snapshot.definitions[0].tools[0]) && Object.isFrozen(snapshot.definitions[0].model) && Object.isFrozen(snapshot.definitions[0].model?.[0]) && Object.isFrozen(snapshot.definitions[0].skills.preload));
	assert.throws(() => { (snapshot.definitions[0].tools[0] as { enabled: boolean }).enabled = true; }, TypeError);
}));
