import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function sanitizeDisplayText(value: string): string {
	return stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function sanitizeXmlText(value: string): string {
	let result = "";
	for (const character of sanitizeDisplayText(value)) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || (codePoint >= 0x20 && codePoint <= 0xd7ff) || (codePoint >= 0xe000 && codePoint <= 0xfffd) || (codePoint >= 0x10000 && codePoint <= 0x10ffff)) result += character;
	}
	return result;
}

export function oneLine(value: string): string {
	return sanitizeDisplayText(value).replace(/[\r\n]+/g, " ");
}

export function escapeXml(value: string): string {
	return sanitizeXmlText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}
