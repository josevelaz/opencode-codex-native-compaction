import { isObject, type JsonObject, type ResponseItem } from "./protocol"

export type NativeCompactionResult = {
	item: ResponseItem
	usage?: JsonObject
}

export async function parseNativeCompaction(response: Response): Promise<NativeCompactionResult> {
	if (!response.ok) throw new Error(`OpenAI Codex compaction failed with HTTP ${response.status}`)
	if (!response.body) throw new Error("OpenAI Codex returned an empty compaction stream")
	const text = await response.text()
	const items: ResponseItem[] = []
	let completed = false
	let usage: JsonObject | undefined
	for (const block of text.replaceAll("\r\n", "\n").split("\n\n")) {
		const data = block.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim()
		if (!data || data === "[DONE]") continue
		let event: unknown
		try {
			event = JSON.parse(data)
		} catch {
			throw new Error("OpenAI Codex returned malformed compaction SSE")
		}
		if (!isObject(event)) continue
		if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
			throw new Error(`OpenAI Codex compaction ended with ${String(event.type)}`)
		}
		if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "compaction") {
			items.push(event.item)
		}
		if (event.type === "response.completed" || event.type === "response.done") {
			completed = true
			if (isObject(event.response) && isObject(event.response.usage)) usage = event.response.usage
		}
	}
	if (!completed) throw new Error("OpenAI Codex compaction stream closed before completion")
	if (items.length !== 1) throw new Error(`OpenAI Codex returned ${items.length} compaction items; expected one`)
	if (typeof items[0]!.encrypted_content !== "string" || !items[0]!.encrypted_content) {
		throw new Error("OpenAI Codex compaction item has no encrypted_content")
	}
	return { item: items[0]!, usage }
}

export function markerResponse(marker: string, usage?: JsonObject): Response {
	const responseID = `resp_native_${crypto.randomUUID().replaceAll("-", "")}`
	const itemID = `msg_native_${crypto.randomUUID().replaceAll("-", "")}`
	const item = {
		id: itemID,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: marker, annotations: [] }],
	}
	const completed = {
		id: responseID,
		object: "response",
		status: "completed",
		model: "codex-native-compaction",
		output: [item],
		usage: usage ?? { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
	}
	const events = [
		{ type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", item_id: itemID, output_index: 0, content_index: 0, delta: marker },
		{ type: "response.output_text.done", item_id: itemID, output_index: 0, content_index: 0, text: marker },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: completed },
	]
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}
