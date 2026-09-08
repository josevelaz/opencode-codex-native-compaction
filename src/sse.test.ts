import { describe, expect, test } from "bun:test"
import { markerResponse, parseNativeCompaction } from "./sse"

function response(events: unknown[], done = true): Response {
	const blocks = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
	return new Response(`${blocks}${done ? "data: [DONE]\r\n\r\n" : ""}`, {
		headers: { "content-type": "text/event-stream" },
	})
}

describe("native compaction SSE", () => {
	test("parses one opaque compaction item and usage", async () => {
		const result = await parseNativeCompaction(response([
			{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque" } },
			{ type: "response.completed", response: { usage: { input_tokens: 12 } } },
		]))
		expect(result).toEqual({
			item: { type: "compaction", encrypted_content: "opaque" },
			usage: { input_tokens: 12 },
		})
	})

	test("rejects missing completion, duplicate items, and malformed JSON", async () => {
		await expect(parseNativeCompaction(response([
			{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque" } },
		], false))).rejects.toThrow("closed before completion")
		await expect(parseNativeCompaction(response([
			{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "one" } },
			{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "two" } },
			{ type: "response.completed", response: {} },
		]))).rejects.toThrow("returned 2 compaction items")
		await expect(parseNativeCompaction(new Response("data: {bad}\n\n"))).rejects.toThrow("malformed compaction SSE")
	})

	test("builds marker SSE accepted by the Responses event shape", async () => {
		const text = await markerResponse("checkpoint marker").text()
		expect(text).toContain('"type":"response.output_text.delta"')
		expect(text).toContain("checkpoint marker")
		expect(text).toEndWith("data: [DONE]\n\n")
	})
})
