import { describe, expect, test } from "bun:test"
import {
	baseRequestBody,
	boundResponseImages,
	checkpointMarker,
	encodeDurableItems,
	markerIDs,
	markerItemIndex,
	mergeFeatureHeader,
	modelKey,
	nativeCompactionBody,
	projectDurableMessages,
	replaceJsonRequest,
	type JsonObject,
} from "./protocol"
import {
	historyAfterMarker,
	isOpenAISubscriptionRequest,
	retainedTokenBudgetForDurable,
	shouldPreserveRequestContext,
} from "./index"

const CHECKPOINT_ID = "12345678-1234-4234-9234-123456789abc"

describe("protocol", () => {
	test("merges the remote compaction feature without duplicates", () => {
		const headers = new Headers({ "x-codex-beta-features": "other, REMOTE_COMPACTION_V2" })
		mergeFeatureHeader(headers)
		expect(headers.get("x-codex-beta-features")).toBe("other,remote_compaction_v2")
	})

	test("finds one marker in wrapping prose", () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		expect(markerIDs({ content: [{ text: `history: ${marker}` }] })).toEqual([CHECKPOINT_ID])
		expect(markerItemIndex([{ role: "user", content: marker }])).toEqual({ index: 0, checkpointID: CHECKPOINT_ID })
	})

	test("rejects duplicate markers", () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		expect(() => markerItemIndex([{ content: marker }, { content: marker }])).toThrow("multiple checkpoint markers")
	})

	test("rejects malformed markers and ignores opaque non-message fields", () => {
		expect(() => markerItemIndex([{ content: "[oc-codex:v1:not-a-uuid]" }])).toThrow("malformed checkpoint marker")
		expect(markerItemIndex([{ type: "compaction", encrypted_content: checkpointMarker(CHECKPOINT_ID) }])).toBeUndefined()
	})

	test("finds markers in non-Responses message bodies", () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		expect(markerIDs({ messages: [{ role: "user", content: [{ type: "text", text: marker }] }] })).toEqual([CHECKPOINT_ID])
	})

	test("keeps only post-checkpoint messages for an incompatible provider", () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		expect(historyAfterMarker({
			messages: [
				{ role: "user", content: "old" },
				{ role: "user", content: [{ type: "text", text: `Historical context: ${marker}` }] },
				{ role: "user", content: "new" },
			],
		}, CHECKPOINT_ID)).toEqual({ messages: [{ role: "user", content: "new" }] })
	})

	test("keeps retained context stored after a marker in the same message", () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		expect(historyAfterMarker({
			input: [{
				role: "user",
				content: [{ type: "input_text", text: `<summary>${marker}</summary>\n<recent-context>retained tail</recent-context>` }],
			}],
		}, CHECKPOINT_ID)).toEqual({
			input: [{
				role: "user",
				content: [{ type: "input_text", text: "</summary>\n<recent-context>retained tail</recent-context>" }],
			}],
		})
	})

	test("rejects a marker that cannot be isolated to a message array", () => {
		expect(() => historyAfterMarker({ metadata: checkpointMarker(CHECKPOINT_ID) }, CHECKPOINT_ID)).toThrow("could not isolate")
	})

	test("adjusts native retention for OpenCode's actual retained tail", () => {
		expect(retainedTokenBudgetForDurable([{
			type: "compaction",
			status: "running",
			recent: "x".repeat(40_000),
		}])).toBe(54_000)
		expect(retainedTokenBudgetForDurable([{
			type: "compaction",
			status: "running",
			recent: "x".repeat(300_000),
		}])).toBe(0)
	})

	test("builds a native compaction body from normal request options", () => {
		const base = baseRequestBody({
			model: "gpt-5.3-codex-spark",
			input: [{ role: "user", content: "hello" }],
			previous_response_id: "resp_old",
			include: ["web_search_call.action.sources"],
		})
		const body = nativeCompactionBody(base, [{ role: "user", content: "hello" }])
		expect(body.previous_response_id).toBeUndefined()
		expect(body.store).toBe(false)
		expect(body.stream).toBe(true)
		expect(body.include).toEqual(["web_search_call.action.sources", "reasoning.encrypted_content"])
		expect(body.input).toEqual([{ role: "user", content: "hello" }, { type: "compaction_trigger" }])
	})

	test("replaces JSON while preserving request metadata", async () => {
		const controller = new AbortController()
		const request = new Request("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: { authorization: "Bearer redacted", "content-length": "1" },
			body: "{}",
			signal: controller.signal,
		})
		const replacement = replaceJsonRequest(request, { input: [] })
		expect(replacement.url).toBe(request.url)
		expect(replacement.method).toBe("POST")
		expect(replacement.headers.get("authorization")).toBe("Bearer redacted")
		expect(replacement.headers.has("content-length")).toBe(false)
		expect(await replacement.json()).toEqual({ input: [] })
	})

	test("model keys include the variant", () => {
		expect(modelKey({ providerID: "openai", id: "codex", variant: "high" })).toBe("openai:codex:high")
	})

	test("recognizes only the OpenAI subscription Responses endpoint", () => {
		expect(isOpenAISubscriptionRequest(new Request("https://chatgpt.com/backend-api/codex/responses"))).toBe(true)
		expect(isOpenAISubscriptionRequest(new Request("https://api.openai.com/v1/responses"))).toBe(false)
		expect(isOpenAISubscriptionRequest(new Request("https://chatgpt.com/backend-api/codex/models"))).toBe(false)
		expect(isOpenAISubscriptionRequest(new Request("http://chatgpt.com/backend-api/codex/responses"))).toBe(false)
	})

	test("preserves toolful request context when warming disables tools", () => {
		expect(shouldPreserveRequestContext({
			previousAgent: "build",
			previousTools: { shell: {} },
			agent: "build",
			tools: {},
		})).toBe(true)
		expect(shouldPreserveRequestContext({
			previousAgent: "build",
			previousTools: { shell: {} },
			agent: "reviewer",
			tools: {},
		})).toBe(false)
	})

	test("encodes a completed checkpoint marker for repeated compaction", async () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		const items = await encodeDurableItems({
			model: { providerID: "openai", id: "gpt-5.3-codex-spark" },
			snapshot: { system: [], tools: {} },
			durable: [{ type: "compaction", status: "completed", summary: marker, recent: "" }],
		})
		expect(markerItemIndex(items)).toEqual({ index: 0, checkpointID: CHECKPOINT_ID })
	})

	test("keeps OpenCode's retained tail after a completed native marker", async () => {
		const marker = checkpointMarker(CHECKPOINT_ID)
		const items = await encodeDurableItems({
			model: { providerID: "openai", id: "gpt-5.3-codex-spark" },
			snapshot: { system: [], tools: {} },
			durable: [{ type: "compaction", status: "completed", summary: marker, recent: "retained tail" }],
		})
		expect(markerItemIndex(items)).toEqual({ index: 0, checkpointID: CHECKPOINT_ID })
		expect(items).toHaveLength(1)
		expect(JSON.stringify(items)).toContain("retained tail")
	})

	test("encodes string-backed user file attachments", async () => {
		const items = await encodeDurableItems({
			model: { providerID: "openai", id: "gpt-5.3-codex-spark" },
			snapshot: { system: [], tools: {} },
			durable: [{
				type: "user",
				text: "inspect",
				files: [{ data: "YWJj", mime: "image/png", name: "image.png", source: { type: "inline" } }],
			}],
		})
		expect(items).toHaveLength(1)
		expect(JSON.stringify(items)).toContain("data:image/png;base64,YWJj")
	})

	test("applies OpenCode's image request-size bound after projection", () => {
		const size = 13 * 1024 * 1024 + 1
		const messages = projectDurableMessages({
			model: { providerID: "openai", id: "gpt-5.3-codex-spark" },
			durable: [{
				type: "user",
				text: "inspect",
				files: [
					{ data: "a".repeat(size), mime: "image/png", source: { type: "inline" } },
					{ data: "b".repeat(size), mime: "image/png", source: { type: "inline" } },
				],
			}],
		})
		expect(messages).toHaveLength(1)
		expect(messages[0]?.content.map((part) => part.type)).toEqual(["text", "text", "media"])
		expect(messages[0]?.content[1]).toEqual(expect.objectContaining({
			type: "text",
			text: expect.stringContaining("removed to reduce the request size"),
		}))
	})

	test("bounds the complete Responses input after checkpoint replay", () => {
		const size = 13 * 1024 * 1024 + 1
		const items = boundResponseImages([
			{ role: "user", content: [{ type: "input_text", text: "retained" }, { type: "input_image", image_url: `data:image/png;base64,${"a".repeat(size)}` }] },
			{ role: "user", content: [{ type: "input_text", text: "current" }, { type: "input_image", image_url: `data:image/png;base64,${"b".repeat(size)}` }] },
		])
		expect((items[0]?.content as JsonObject[])[1]).toEqual(expect.objectContaining({
			type: "input_text",
			text: expect.stringContaining("removed to reduce the request size"),
		}))
		expect((items[1]?.content as JsonObject[])[1]).toEqual(expect.objectContaining({ type: "input_image" }))
	})

	test("uses OpenCode's canonical projection for synthetic, skill, shell, and location records", async () => {
		const items = await encodeDurableItems({
			model: { providerID: "openai", id: "gpt-5.3-codex-spark" },
			snapshot: { system: [], tools: {} },
			durable: [
				{ type: "synthetic", id: "msg_synthetic", text: "subagent completed" },
				{ type: "skill", id: "msg_skill", text: "skill instructions", metadata: { source: "skill" } },
				{ type: "shell", id: "msg_shell", command: "printf hello", output: { output: "hello" } },
				{ type: "location-switched", id: "msg_location", location: { directory: "/workspace/next" } },
			],
		})
		const encoded = JSON.stringify(items)
		expect(items).toHaveLength(4)
		expect(encoded).toContain("subagent completed")
		expect(encoded).toContain("skill instructions")
		expect(encoded).toContain("printf hello")
		expect(encoded).toContain("/workspace/next")
	})

	test("ignores model and agent controls but projects location changes", async () => {
		const items = await encodeDurableItems({
			model: { providerID: "openai", id: "gpt-5.3-codex-spark" },
			snapshot: { system: [], tools: {} },
			durable: [
				{ type: "agent-switched", agent: "build" },
				{ type: "model-switched", model: { providerID: "openai", id: "gpt-5.3-codex-spark" } },
				{ type: "location-switched", location: { directory: "/tmp" } },
				{ type: "user", text: "hello" },
			],
		})
		expect(items).toHaveLength(2)
		expect(JSON.stringify(items)).toContain("/tmp")
		expect(JSON.stringify(items)).toContain("hello")
	})
})
