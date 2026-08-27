import { readFileSync } from "node:fs";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { escapeXml, sanitizeXmlText } from "./text.ts";

export function resolvePreloadedSkills(availableSkills: readonly Skill[], requestedNames?: readonly string[]): Skill[] {
	if (!requestedNames?.length) return [];
	const skillsByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
	const names = [...new Set(requestedNames.map((name) => {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("Skill names must be non-empty.");
		return trimmed;
	}))];
	const missing = names.filter((name) => !skillsByName.has(name));
	if (missing.length) throw new Error(`Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.${availableSkills.length ? ` Available skills: ${availableSkills.map((skill) => skill.name).join(", ")}.` : ""}`);
	return names.map((name) => skillsByName.get(name)!);
}

export function formatPreloadedSkills(skills: readonly Skill[]): string {
	const blocks = skills.map((skill) => {
		const parsed = parseFrontmatter(readFileSync(skill.filePath, "utf-8"));
		return `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${escapeXml(skill.baseDir)}.\n\n${sanitizeXmlText(parsed.body)}\n</skill>`;
	});
	return ["The following skills were explicitly pre-loaded for this task. Respect them when carrying out the task.", "<preloaded_skills>", blocks.join("\n\n"), "</preloaded_skills>"].join("\n");
}
