import { isObject, type ResponseItem } from "./protocol"

export const RETAINED_TOKEN_BUDGET = 64_000

function text(item: ResponseItem): string {
	if (typeof item.content === "string") return item.content
	if (!Array.isArray(item.content)) return ""
	return item.content.flatMap((part) => isObject(part) && typeof part.text === "string" ? [part.text] : []).join("")
}

function eligible(item: ResponseItem): boolean {
	return (item.type === "message" || item.type === undefined)
		&& (item.role === "user" || item.role === "developer" || item.role === "system")
		&& text(item).trim().length > 0
}

export function replacementHistory(input: ResponseItem[], compaction: ResponseItem, budget = RETAINED_TOKEN_BUDGET): ResponseItem[] {
	if (compaction.type !== "compaction" || typeof compaction.encrypted_content !== "string" || !compaction.encrypted_content) {
		throw new Error("OpenAI Codex returned an invalid compaction item")
	}
	let remaining = budget
	const retained: ResponseItem[] = []
	for (const item of [...input].reverse()) {
		if (!eligible(item) || remaining <= 0) continue
		const tokens = Math.max(1, Math.ceil(text(item).length / 4))
		if (tokens > remaining) continue
		retained.push(structuredClone(item))
		remaining -= tokens
	}
	retained.reverse()
	return [...retained, structuredClone(compaction)]
}
