import { describe, expect, test } from "bun:test"
import plugin from "./index"
import { hostCheckpointSummary, markerIDs } from "./protocol"
import { checkpointKey } from "./state"

const SESSION = "ses_test"
const ASTRA = { providerID: "openai", id: "gpt-6-astra" }
const SOL = { providerID: "openai", id: "gpt-5.4" }
const SUBSCRIPTION = "https://chatgpt.com/backend-api/codex/responses"
const HOST_HEADINGS = [
	"## Objective",
	"## Requirements",
	"## Decisions",
	"## Work State",
	"## Next Move",
	"## Relevant Files",
	"## Additional Context",
]

function hostAcceptsSummary(text: string): boolean {
	return text.split("\n").some((line) => HOST_HEADINGS.includes(line.trim()))
}

function nativeSSE(content = "opaque"): Response {
	const events = [
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: content } },
		{ type: "response.completed", response: { usage: { input_tokens: 12 } } },
	]
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	})
}

async function summaryFrom(response: Response): Promise<string> {
	const text = await response.clone().text()
	for (const block of text.split("\n\n")) {
		const line = block.split("\n").find((entry) => entry.startsWith("data:"))
		if (!line) continue
		const data = line.slice(5).trim()
		if (!data || data === "[DONE]") continue
		const event = JSON.parse(data) as { type?: string; text?: string }
		if (event.type === "response.output_text.done" && typeof event.text === "string") return event.text
	}
	throw new Error("marker response did not include summary text")
}

async function jsonBody(request: Request): Promise<unknown> {
	return request.clone().json()
}

function jsonRequest(body: unknown): Request {
	return new Request(SUBSCRIPTION, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})
}

async function startPlugin(options: {
	durable?: unknown[]
	failSet?: (key: string) => boolean
} = {}) {
	const storage = new Map<string, unknown>()
	const hooks = new Map<string, (event: any) => Promise<void>>()
	const queue: unknown[] = []
	let waiter: ((event: unknown) => void) | undefined
	let durable = options.durable ?? [{ type: "user", text: "hello" }]

	const ctx = {
		options: {},
		storage: {
			async get(key: string) {
				return storage.get(key)
			},
			async set(key: string, value: unknown) {
				if (options.failSet?.(key)) throw new Error("storage failed")
				storage.set(key, value)
			},
			async remove(key: string) {
				storage.delete(key)
			},
			async scan() {
				return { entries: [] }
			},
		},
		event: {
			subscribe({ signal }: { signal: AbortSignal }) {
				return {
					async *[Symbol.asyncIterator]() {
						while (!signal.aborted) {
							if (queue.length > 0) {
								yield queue.shift()
								continue
							}
							const event = await new Promise((resolve) => {
								const onAbort = () => resolve(undefined)
								signal.addEventListener("abort", onAbort, { once: true })
								waiter = (next) => {
									signal.removeEventListener("abort", onAbort)
									resolve(next)
								}
							})
							if (event === undefined) return
							yield event
						}
					},
				}
			},
		},
		session: {
			hook: async (name: string, callback: (event: any) => Promise<void>) => {
				hooks.set(name, callback)
				return { dispose() {} }
			},
			context: async () => durable,
			synthetic: async () => {},
		},
	}

	const cleanup = await plugin.setup(ctx as never)

	return {
		storage,
		hooks,
		setDurable(value: unknown[]) {
			durable = value
		},
		async emit(event: unknown) {
			if (waiter) {
				const resume = waiter
				waiter = undefined
				resume(event)
			} else {
				queue.push(event)
			}
			await new Promise((resolve) => setTimeout(resolve, 25))
		},
		async cleanup() {
			if (typeof cleanup === "function") await cleanup()
		},
	}
}

async function prime(harness: Awaited<ReturnType<typeof startPlugin>>, model: { providerID: string; id: string }) {
	await harness.hooks.get("context")!({
		sessionID: SESSION,
		agent: "build",
		model,
		system: [],
		tools: { shell: { description: "run", input: {} } },
	})
	const event = {
		sessionID: SESSION,
		agent: "build",
		model,
		request: jsonRequest({ model: model.id, input: [{ role: "user", content: "hello" }] }),
	}
	await harness.hooks.get("http.request")!(event)
}

async function dispatchCompaction(harness: Awaited<ReturnType<typeof startPlugin>>, model: { providerID: string; id: string }) {
	const event = {
		sessionID: SESSION,
		agent: "compaction",
		model,
		request: jsonRequest({ model: model.id, input: [{ role: "user", content: "summarize" }] }),
	}
	await harness.hooks.get("http.request")!(event)
	return event
}

describe("native compaction plugin", () => {
	for (const model of [ASTRA, SOL]) {
		test(`stores a host-accepted marker and replays it on ${model.id}`, async () => {
			const harness = await startPlugin()
			try {
				await prime(harness, model)
				await dispatchCompaction(harness, model)
				const responseEvent = {
					sessionID: SESSION,
					agent: "compaction",
					model,
					request: jsonRequest({}),
					response: nativeSSE(),
				}
				await harness.hooks.get("http.response")!(responseEvent)
				const summary = await summaryFrom(responseEvent.response)
				expect(hostAcceptsSummary(summary)).toBe(true)
				expect(summary.startsWith("## Additional Context\n")).toBe(true)
				const checkpointID = markerIDs(summary)[0]
				expect(checkpointID).toBeDefined()

				await harness.emit({
					type: "session.compaction.ended",
					created: Date.now(),
					data: { sessionID: SESSION, reason: "auto", text: summary, recent: "" },
				})

				const next = {
					sessionID: SESSION,
					agent: "build",
					model,
					request: jsonRequest({ model: model.id, input: [{ role: "user", content: "continue" }] }),
				}
				await harness.hooks.get("http.request")!(next)
				const body = await jsonBody(next.request) as { input: unknown[] }
				expect(JSON.stringify(body.input)).toContain("opaque")
				expect(markerIDs(body)).toEqual([])
				expect(harness.storage.get(`active-checkpoint/${SESSION}`)).toEqual({ version: 1, checkpointID })
			} finally {
				await harness.cleanup()
			}
		})
	}

	test("replays the stored marker when the host retries the same compaction", async () => {
		const harness = await startPlugin()
		try {
			await prime(harness, ASTRA)
			await dispatchCompaction(harness, ASTRA)
			const first = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE(),
			}
			await harness.hooks.get("http.response")!(first)
			const firstSummary = await summaryFrom(first.response)
			expect(hostAcceptsSummary(firstSummary)).toBe(true)

			await expect(dispatchCompaction(harness, ASTRA)).resolves.toBeDefined()
			const retry = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: new Response("not a native stream"),
			}
			await harness.hooks.get("http.response")!(retry)
			const retrySummary = await summaryFrom(retry.response)
			expect(retrySummary).toBe(firstSummary)
			expect(markerIDs(retrySummary)).toEqual(markerIDs(firstSummary))
		} finally {
			await harness.cleanup()
		}
	})

	test("clears a failed parse so a later attempt can run", async () => {
		const harness = await startPlugin()
		try {
			await prime(harness, ASTRA)
			await dispatchCompaction(harness, ASTRA)
			await expect(harness.hooks.get("http.response")!({
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: new Response("data: {bad}\n\n"),
			})).rejects.toThrow("malformed compaction SSE")

			await dispatchCompaction(harness, ASTRA)
			const responseEvent = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE("second"),
			}
			await harness.hooks.get("http.response")!(responseEvent)
			expect(await summaryFrom(responseEvent.response)).toContain("## Additional Context")
		} finally {
			await harness.cleanup()
		}
	})

	test("clears a failed storage write so a later attempt can run", async () => {
		const harness = await startPlugin({
			failSet: (key) => key.startsWith("checkpoint/"),
		})
		try {
			await prime(harness, SOL)
			await dispatchCompaction(harness, SOL)
			await expect(harness.hooks.get("http.response")!({
				sessionID: SESSION,
				agent: "compaction",
				model: SOL,
				request: jsonRequest({}),
				response: nativeSSE(),
			})).rejects.toThrow("storage failed")

			await dispatchCompaction(harness, SOL)
			expect([...harness.storage.keys()].some((key) => key.startsWith("checkpoint/"))).toBe(false)
		} finally {
			await harness.cleanup()
		}
	})

	test("failed compaction leaves the previous active checkpoint in place", async () => {
		const harness = await startPlugin()
		try {
			await prime(harness, ASTRA)
			await dispatchCompaction(harness, ASTRA)
			const first = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE("first"),
			}
			await harness.hooks.get("http.response")!(first)
			const firstSummary = await summaryFrom(first.response)
			const firstID = markerIDs(firstSummary)[0]!
			await harness.emit({
				type: "session.compaction.ended",
				created: Date.now(),
				data: { sessionID: SESSION, reason: "auto", text: firstSummary, recent: "" },
			})

			await dispatchCompaction(harness, ASTRA)
			await expect(harness.hooks.get("http.response")!({
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: new Response("data: {bad}\n\n"),
			})).rejects.toThrow("malformed compaction SSE")

			expect(harness.storage.get(`active-checkpoint/${SESSION}`)).toEqual({ version: 1, checkpointID: firstID })
			expect(harness.storage.get(checkpointKey(SESSION, firstID))).toBeDefined()
		} finally {
			await harness.cleanup()
		}
	})

	test("a delayed failed event does not clear a newer attempt", async () => {
		const harness = await startPlugin()
		try {
			await prime(harness, ASTRA)
			await dispatchCompaction(harness, ASTRA)
			const startedAt = Date.now()
			await harness.emit({
				type: "session.compaction.failed",
				created: startedAt - 5_000,
				data: {
					sessionID: SESSION,
					reason: "auto",
					error: { type: "compaction.failed", message: "old" },
				},
			})
			const responseEvent = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE("kept"),
			}
			await harness.hooks.get("http.response")!(responseEvent)
			expect(await summaryFrom(responseEvent.response)).toContain("## Additional Context")
			expect([...harness.storage.keys()].some((key) => key.startsWith("checkpoint/"))).toBe(true)
		} finally {
			await harness.cleanup()
		}
	})

	test("a delayed ended event for an older checkpoint does not drop a newer pending attempt", async () => {
		const harness = await startPlugin()
		try {
			await prime(harness, ASTRA)
			await dispatchCompaction(harness, ASTRA)
			const first = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE("first"),
			}
			await harness.hooks.get("http.response")!(first)
			const firstSummary = await summaryFrom(first.response)
			const firstID = markerIDs(firstSummary)[0]!
			await harness.emit({
				type: "session.compaction.ended",
				created: Date.now(),
				data: { sessionID: SESSION, reason: "auto", text: firstSummary, recent: "" },
			})

			await dispatchCompaction(harness, ASTRA)
			await harness.emit({
				type: "session.compaction.ended",
				created: Date.now() - 5_000,
				data: { sessionID: SESSION, reason: "auto", text: hostCheckpointSummary(firstID), recent: "" },
			})

			const retry = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE("second"),
			}
			await harness.hooks.get("http.response")!(retry)
			const retrySummary = await summaryFrom(retry.response)
			expect(markerIDs(retrySummary)[0]).not.toBe(firstID)
			expect(harness.storage.get(`active-checkpoint/${SESSION}`)).toEqual({ version: 1, checkpointID: firstID })
		} finally {
			await harness.cleanup()
		}
	})

	test("clears pending state when the host reports compaction failed", async () => {
		const harness = await startPlugin()
		try {
			await prime(harness, ASTRA)
			await dispatchCompaction(harness, ASTRA)
			await harness.emit({
				type: "session.compaction.failed",
				created: Date.now(),
				data: {
					sessionID: SESSION,
					reason: "manual",
					error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
				},
			})
			await dispatchCompaction(harness, ASTRA)
			const responseEvent = {
				sessionID: SESSION,
				agent: "compaction",
				model: ASTRA,
				request: jsonRequest({}),
				response: nativeSSE("after-cancel"),
			}
			await harness.hooks.get("http.response")!(responseEvent)
			expect(hostAcceptsSummary(await summaryFrom(responseEvent.response))).toBe(true)
		} finally {
			await harness.cleanup()
		}
	})
})
