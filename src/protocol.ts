import { LanguageModel, LLMRequest, Message, ToolDefinition } from "@opencode-ai/ai"
import { OpenAIResponses } from "@opencode-ai/ai/protocols/openai-responses"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { Effect } from "effect"

export type JsonObject = Record<string, unknown>
export type ResponseItem = JsonObject

export type ModelRef = {
	providerID: string
	id: string
	variant?: string
}

export type ContextSnapshot = {
	system: any[]
	tools: Record<string, { description: string; input: Record<string, unknown> }>
}

export const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2"
const MARKER_PATTERN = /\[oc-codex:v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g
const MARKER_PREFIX = "[oc-codex:v1:"
const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024
const IMAGE_REMOVED = "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function modelKey(model: ModelRef): string {
	return `${model.providerID}:${model.id}:${model.variant ?? ""}`
}

export function checkpointMarker(checkpointID: string): string {
	return `OpenAI Codex native checkpoint [oc-codex:v1:${checkpointID}]`
}

function textValues(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(textValues)
	if (isObject(value)) {
		const values: string[] = []
		if (typeof value.text === "string") values.push(value.text)
		for (const key of ["content", "input", "messages", "contents"] as const) {
			if (value[key] !== undefined) values.push(...textValues(value[key]))
		}
		return values
	}
	return []
}

export function markerIDs(value: unknown): string[] {
	const ids: string[] = []
	for (const text of textValues(value)) {
		for (const match of text.matchAll(MARKER_PATTERN)) ids.push(match[1]!)
		if (text.replace(MARKER_PATTERN, "").includes(MARKER_PREFIX)) {
			throw new Error("native compaction request contains a malformed checkpoint marker")
		}
	}
	return ids
}

export function mergeFeatureHeader(headers: Headers): void {
	const features = (headers.get("x-codex-beta-features") ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
	const normalized = new Map(features.map((feature) => [feature.toLowerCase(), feature]))
	normalized.set(REMOTE_COMPACTION_FEATURE, REMOTE_COMPACTION_FEATURE)
	headers.set("x-codex-beta-features", [...normalized.values()].join(","))
}

export function replaceJsonRequest(request: Request, body: JsonObject, headers = new Headers(request.headers)): Request {
	headers.delete("content-length")
	return new Request(request, { body: JSON.stringify(body), headers })
}

export function baseRequestBody(body: JsonObject): JsonObject {
	const base = structuredClone(body)
	delete base.input
	delete base.messages
	delete base.previous_response_id
	return base
}

export function nativeCompactionBody(base: JsonObject, input: ResponseItem[]): JsonObject {
	const include = Array.isArray(base.include)
		? [...new Set([...base.include.filter((value): value is string => typeof value === "string"), "reasoning.encrypted_content"])]
		: ["reasoning.encrypted_content"]
	const body: JsonObject = {
		...structuredClone(base),
		store: false,
		stream: true,
		include,
		input: [...structuredClone(input), { type: "compaction_trigger" }],
	}
	delete body.messages
	delete body.previous_response_id
	return body
}

function boundImages(messages: readonly Message[]): Message[] {
	const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")
	const size = (data: string | Uint8Array) => typeof data === "string"
		? Buffer.byteLength(data)
		: Math.ceil(data.byteLength / 3) * 4
	const imageBytes = messages.reduce((total, message) => total + message.content.reduce((sum, part) => {
		if (part.type === "media" && isImage(part.mediaType)) return sum + size(part.data)
		if (part.type !== "tool-result" || part.result.type !== "content") return sum
		return sum + part.result.value.reduce((bytes, item) => bytes
			+ (item.type === "file" && isImage(item.mime) ? Buffer.byteLength(item.uri) : 0), 0)
	}, 0), 0)
	if (imageBytes <= IMAGE_BYTES_TRIGGER) return [...messages]

	let removed = 0
	return messages.map((message) => Message.make({
		...message,
		content: message.content.map((part) => {
			if (part.type === "media" && isImage(part.mediaType) && imageBytes - removed > IMAGE_BYTES_TARGET) {
				removed += size(part.data)
				return Message.text(IMAGE_REMOVED)
			}
			if (part.type !== "tool-result" || part.result.type !== "content") return part
			return {
				...part,
				result: {
					...part.result,
					value: part.result.value.map((item) => {
						if (item.type !== "file" || !isImage(item.mime) || imageBytes - removed <= IMAGE_BYTES_TARGET) {
							return item
						}
						removed += Buffer.byteLength(item.uri)
						return { type: "text" as const, text: IMAGE_REMOVED }
					}),
				},
			}
		}),
	}))
}

function responseImagePayloadBytes(url: string): number {
	const marker = ";base64,"
	const index = url.indexOf(marker)
	return Buffer.byteLength(index < 0 ? url : url.slice(index + marker.length))
}

function responseImageParts(value: unknown): Array<JsonObject & { image_url: string }> {
	if (Array.isArray(value)) return value.flatMap(responseImageParts)
	if (!isObject(value)) return []
	if (value.type === "input_image" && typeof value.image_url === "string") {
		return [value as JsonObject & { image_url: string }]
	}
	return Object.values(value).flatMap(responseImageParts)
}

export function boundResponseImages(items: readonly ResponseItem[]): ResponseItem[] {
	const bounded = structuredClone([...items])
	const images = responseImageParts(bounded)
	const imageBytes = images.reduce((total, image) => total + responseImagePayloadBytes(image.image_url), 0)
	if (imageBytes <= IMAGE_BYTES_TRIGGER) return bounded

	let removed = 0
	for (const image of images) {
		if (imageBytes - removed <= IMAGE_BYTES_TARGET) break
		removed += responseImagePayloadBytes(image.image_url)
		for (const key of Object.keys(image)) delete image[key]
		image.type = "input_text"
		image.text = IMAGE_REMOVED
	}
	return bounded
}

export function projectDurableMessages(input: { model: ModelRef; durable: readonly any[] }): Message[] {
	const projected = toLLMMessages(input.durable, input.model as Parameters<typeof toLLMMessages>[1])
	return boundImages(projected)
}

export async function encodeDurableItems(input: {
	model: ModelRef
	snapshot: ContextSnapshot
	durable: readonly any[]
}): Promise<ResponseItem[]> {
	const model = LanguageModel.make({ id: input.model.id, provider: "openai", route: OpenAIResponses.route })
	const request = new LLMRequest({
		model,
		system: input.snapshot.system,
		messages: projectDurableMessages(input),
		tools: Object.entries(input.snapshot.tools).map(([name, tool]) => ToolDefinition.make({
			name,
			description: tool.description,
			inputSchema: tool.input,
		})),
	})
	const body = await Effect.runPromise(OpenAIResponses.protocol.body.from(request))
	return structuredClone([...body.input]) as ResponseItem[]
}

export function markerItemIndex(input: unknown[]): { index: number; checkpointID: string } | undefined {
	const matches = input.flatMap((item, index) => markerIDs(item).map((checkpointID) => ({ index, checkpointID })))
	if (matches.length === 0) return undefined
	if (matches.length !== 1) throw new Error("native compaction request contains multiple checkpoint markers")
	return matches[0]
}
