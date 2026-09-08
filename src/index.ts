import { Plugin } from "@opencode-ai/plugin"
import type { Schema } from "effect"
import { replacementHistory } from "./history"
import { RETAINED_TOKEN_BUDGET } from "./history"
import {
	baseRequestBody,
	boundResponseImages,
	encodeDurableItems,
	hostCheckpointSummary,
	isObject,
	markerIDs,
	markerItemIndex,
	mergeFeatureHeader,
	modelKey,
	nativeCompactionBody,
	replaceJsonRequest,
	type ContextSnapshot,
	type JsonObject,
	type ModelRef,
	type ResponseItem,
} from "./protocol"
import {
	compactionHttpAction,
	shouldDiscardCheckpoint,
	summaryCommitsCheckpoint,
	terminalEventTargetsAttempt,
	type PendingPhase,
} from "./pending"
import { markerResponse, parseNativeCompaction } from "./sse"
import {
	checkpointKey,
	checkpointPrefix,
	parseCheckpoint,
	requireCompatible,
	type NativeCheckpoint,
} from "./state"

type Options = {
	debug?: unknown
}

type PendingCompaction = {
	checkpointID: string
	model: ModelRef
	input: ResponseItem[]
	retainedTokenBudget: number
	phase: PendingPhase
	createdAt: number
	usage?: JsonObject
}

type SessionState = {
	snapshot?: ContextSnapshot
	base?: JsonObject
	model?: ModelRef
	agent?: string
	preserveRequestContext?: boolean
	pending?: PendingCompaction
}

type DurableRequestContext = {
	version: 1
	snapshot: ContextSnapshot
	base: JsonObject
	model: ModelRef
	agent?: string
}

function copyModel(model: ModelRef): ModelRef {
	return model.variant === undefined
		? { providerID: model.providerID, id: model.id }
		: { providerID: model.providerID, id: model.id, variant: model.variant }
}

function options(value: Options): { debug: boolean } {
	if (value.debug !== undefined && typeof value.debug !== "boolean") {
		throw new Error("codex native compaction debug must be a boolean")
	}
	return { debug: value.debug === true }
}

function responseBody(value: unknown): value is JsonObject & { input: ResponseItem[] } {
	return isObject(value) && Array.isArray(value.input) && value.input.every(isObject)
}

export function shouldPreserveRequestContext(input: {
	previousAgent?: string
	previousTools?: Record<string, unknown>
	agent: string
	tools: Record<string, unknown>
}): boolean {
	return input.previousAgent === input.agent
		&& Object.keys(input.previousTools ?? {}).length > 0
		&& Object.keys(input.tools).length === 0
}

export function isOpenAISubscriptionRequest(request: Request): boolean {
	const url = new URL(request.url)
	return url.protocol === "https:"
		&& url.hostname === "chatgpt.com"
		&& url.pathname.startsWith("/backend-api/codex/")
		&& url.pathname.endsWith("/responses")
}

export function historyAfterMarker(body: JsonObject, checkpointID: string): JsonObject {
	const replacement = structuredClone(body)
	let markerCount = 0
	for (const key of ["input", "messages", "contents"] as const) {
		const items = replacement[key]
		if (!Array.isArray(items)) continue
		const matches = items.flatMap((item, index) => markerIDs(item).map((id) => ({ id, index })))
		for (const match of matches) {
			if (match.id !== checkpointID) throw new Error("native compaction request contains an unexpected checkpoint marker")
			markerCount++
			const boundaryTail = valueAfterMarker(items[match.index], checkpointID)
			replacement[key] = boundaryTail === undefined
				? structuredClone(items.slice(match.index + 1))
				: [boundaryTail, ...structuredClone(items.slice(match.index + 1))]
		}
	}
	if (markerCount !== 1) throw new Error("native compaction could not isolate the checkpoint boundary")
	if (markerIDs(replacement).length !== 0) throw new Error("native compaction marker remained after removing checkpoint history")
	return replacement
}

function valueAfterMarker(value: unknown, checkpointID: string): unknown | undefined {
	const token = `[oc-codex:v1:${checkpointID}]`
	if (typeof value === "string") {
		const index = value.indexOf(token)
		if (index < 0) return structuredClone(value)
		const tail = value.slice(index + token.length).trimStart()
		return tail.length > 0 ? tail : undefined
	}
	if (Array.isArray(value)) {
		const index = value.findIndex((item) => markerIDs(item).includes(checkpointID))
		if (index < 0) return structuredClone(value)
		const boundaryTail = valueAfterMarker(value[index], checkpointID)
		return boundaryTail === undefined
			? structuredClone(value.slice(index + 1))
			: [boundaryTail, ...structuredClone(value.slice(index + 1))]
	}
	if (!isObject(value)) return structuredClone(value)

	for (const key of ["text", "content", "input", "messages", "contents"] as const) {
		if (value[key] === undefined || !markerIDs(value[key]).includes(checkpointID)) continue
		const tail = valueAfterMarker(value[key], checkpointID)
		if (tail === undefined || (Array.isArray(tail) && tail.length === 0)) return undefined
		return { ...structuredClone(value), [key]: tail }
	}
	return structuredClone(value)
}

export function retainedTokenBudgetForDurable(items: readonly unknown[]): number {
	const running = [...items].reverse().find((item) => isObject(item)
		&& item.type === "compaction"
		&& item.status === "running")
	const recent = isObject(running) && typeof running.recent === "string" ? running.recent : ""
	return Math.max(0, RETAINED_TOKEN_BUDGET - Math.ceil(recent.length / 4))
}

function storageJson(value: unknown): Schema.Json {
	return JSON.parse(JSON.stringify(value)) as Schema.Json
}

function requestContextKey(sessionID: string): string {
	return `request-context/${sessionID}`
}

function activeCheckpointKey(sessionID: string): string {
	return `active-checkpoint/${sessionID}`
}

function warningStorageKey(sessionID: string, checkpointID: string, model: ModelRef): string {
	return `switch-warning/${sessionID}/${checkpointID}/${encodeURIComponent(modelKey(model))}`
}

function parseRequestContext(value: unknown): DurableRequestContext {
	if (!isObject(value) || value.version !== 1 || !isObject(value.snapshot) || !Array.isArray(value.snapshot.system)
		|| !isObject(value.snapshot.tools) || !isObject(value.base) || !isObject(value.model)
		|| typeof value.model.providerID !== "string" || typeof value.model.id !== "string"
		|| (value.model.variant !== undefined && typeof value.model.variant !== "string")
		|| (value.agent !== undefined && typeof value.agent !== "string")) {
		throw new Error("native compaction request context is malformed")
	}
	return value as DurableRequestContext
}

export default Plugin.define({
	id: "codex-native-compaction",
	async setup(ctx) {
		const config = options(ctx.options)
		const sessions = new Map<string, SessionState>()
		const switchWarnings = new Set<string>()
		const abort = new AbortController()

		const log = (message: string, fields: Record<string, string> = {}) => {
			if (!config.debug) return
			console.error(JSON.stringify({ plugin: "codex-native-compaction", message, ...fields }))
		}

		const stateOf = (sessionID: string): SessionState => {
			const existing = sessions.get(sessionID)
			if (existing) return existing
			const created: SessionState = {}
			sessions.set(sessionID, created)
			return created
		}

		const readCheckpoint = async (sessionID: string, checkpointID: string) => {
			const stored = await ctx.storage.get(checkpointKey(sessionID, checkpointID))
			if (stored === undefined) throw new Error(`native compaction checkpoint ${checkpointID} is missing`)
			return parseCheckpoint(stored)
		}

		const loadCheckpoint = async (sessionID: string, checkpointID: string, model: ModelRef) => {
			const checkpoint = await readCheckpoint(sessionID, checkpointID)
			requireCompatible(checkpoint, sessionID, model)
			return checkpoint
		}

		const activeCheckpointID = async (sessionID: string): Promise<string | undefined> => {
			const value = await ctx.storage.get(activeCheckpointKey(sessionID))
			if (value === undefined) return undefined
			if (!isObject(value) || value.version !== 1 || typeof value.checkpointID !== "string") {
				throw new Error("native compaction active checkpoint pointer is malformed")
			}
			return value.checkpointID
		}

		const setActiveCheckpoint = async (sessionID: string, checkpointID: string) => {
			await ctx.storage.set(activeCheckpointKey(sessionID), { version: 1, checkpointID })
		}

		const discardUncommitted = async (sessionID: string, checkpointID: string, reason: string) => {
			const state = sessions.get(sessionID)
			if (state?.pending?.checkpointID === checkpointID) state.pending = undefined
			const activeID = await activeCheckpointID(sessionID)
			if (!shouldDiscardCheckpoint({ checkpointID, activeID, hostCommitted: false })) {
				log("compaction attempt left committed checkpoint in place", { sessionID, checkpointID, reason })
				return
			}
			await ctx.storage.remove(checkpointKey(sessionID, checkpointID))
			log(reason, { sessionID, checkpointID })
		}

		const markerSSE = (pending: PendingCompaction) => markerResponse(hostCheckpointSummary(pending.checkpointID), pending.usage)

		const inputWithActiveCheckpoint = async (items: ResponseItem[], sessionID: string, model: ModelRef) => {
			const checkpointID = await activeCheckpointID(sessionID)
			if (!checkpointID) return structuredClone(items)
			const marker = markerItemIndex(items)
			if (marker) {
				if (marker.checkpointID !== checkpointID) {
					throw new Error("native compaction request contains an unexpected checkpoint marker")
				}
				const resolved = await resolveCheckpoint(items, sessionID, model)
				return resolved
			}
			const checkpoint = await loadCheckpoint(sessionID, checkpointID, model)
			return [...structuredClone(checkpoint.replacementHistory), ...structuredClone(items)]
		}

		const ensureSwitchWarning = async (sessionID: string, checkpointID: string, targetModel: ModelRef) => {
			const key = warningStorageKey(sessionID, checkpointID, targetModel)
			if (switchWarnings.has(key) || await ctx.storage.get(key) === true) return
			const checkpoint = await readCheckpoint(sessionID, checkpointID)
			await ctx.session.synthetic({
				sessionID,
				text: `Warning: ${modelKey(targetModel)} cannot read the OpenAI native checkpoint created by ${modelKey(checkpoint.model)}. Continuing with messages after that checkpoint only. Switch back to ${modelKey(checkpoint.model)} to restore the full context.`,
				description: "OpenAI native checkpoint model-switch warning",
				metadata: { codexNativeCompactionWarning: true },
			})
			await ctx.storage.set(key, true)
			switchWarnings.add(key)
		}

		const resolveCheckpoint = async (items: ResponseItem[], sessionID: string, model: ModelRef): Promise<ResponseItem[]> => {
			const marker = markerItemIndex(items)
			if (!marker) return structuredClone(items)
			const checkpoint = await loadCheckpoint(sessionID, marker.checkpointID, model)
			const tailBody = historyAfterMarker({ input: items }, marker.checkpointID)
			const resolved = [...structuredClone(checkpoint.replacementHistory), ...structuredClone(tailBody.input as ResponseItem[])]
			if (markerItemIndex(resolved)) throw new Error("native compaction marker remained after checkpoint resolution")
			return resolved
		}

		const hydrateRequestContext = async (sessionID: string, state: SessionState) => {
			if (state.snapshot && state.base && state.model) return
			const stored = await ctx.storage.get(requestContextKey(sessionID))
			if (stored === undefined) return
			const context = parseRequestContext(stored)
			state.snapshot = structuredClone(context.snapshot)
			state.base = structuredClone(context.base)
			state.model = copyModel(context.model)
			state.agent = context.agent
		}

		const copyForkCheckpoints = async (parentID: string, sessionID: string) => {
			let after: string | undefined
			do {
				const result = await ctx.storage.scan({ prefix: checkpointPrefix(parentID), after, limit: 100 })
				for (const entry of result.entries) {
					const checkpointID = entry.key.slice(checkpointPrefix(parentID).length)
					const checkpoint = parseCheckpoint(entry.value)
					await ctx.storage.set(checkpointKey(sessionID, checkpointID), storageJson({ ...checkpoint, sessionID }))
				}
				after = result.next
			} while (after !== undefined)
			const requestContext = await ctx.storage.get(requestContextKey(parentID))
			if (requestContext !== undefined) {
				parseRequestContext(requestContext)
				await ctx.storage.set(requestContextKey(sessionID), requestContext)
			}
			const activeCheckpoint = await ctx.storage.get(activeCheckpointKey(parentID))
			if (activeCheckpoint !== undefined) {
				await ctx.storage.set(activeCheckpointKey(sessionID), activeCheckpoint)
			}
		}

		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
					try {
						if (event.type === "session.compaction.failed") {
							const pending = sessions.get(event.data.sessionID)?.pending
							if (!pending || !terminalEventTargetsAttempt(pending, event.created)) continue
							await discardUncommitted(event.data.sessionID, pending.checkpointID, "compaction failed")
						} else if (event.type === "session.compaction.ended") {
							const sessionID = event.data.sessionID
							const state = sessions.get(sessionID)
							const pending = state?.pending
							const text = event.data.text
							const ids = markerIDs(text)
							if (ids.length > 1) throw new Error("native compaction summary contains multiple checkpoint markers")
							const endedID = ids[0]
							if (pending && !terminalEventTargetsAttempt(pending, event.created) && endedID !== pending.checkpointID) {
								continue
							}
							if (pending && state && summaryCommitsCheckpoint(text, pending.checkpointID)) {
								state.pending = undefined
								await setActiveCheckpoint(sessionID, pending.checkpointID)
								log("compaction committed", { sessionID, checkpointID: pending.checkpointID })
								continue
							}
							if (pending && (!endedID || endedID === pending.checkpointID)) {
								if (terminalEventTargetsAttempt(pending, event.created)) {
									await discardUncommitted(sessionID, pending.checkpointID, "compaction marker was not committed")
								}
								continue
							}
							if (endedID && pending && endedID !== pending.checkpointID) {
								if (await ctx.storage.get(checkpointKey(sessionID, endedID)) !== undefined) {
									await setActiveCheckpoint(sessionID, endedID)
									log("compaction committed earlier attempt", { sessionID, checkpointID: endedID })
								}
								continue
							}
							if (endedID && !pending && await activeCheckpointID(sessionID) === undefined) {
								if (await ctx.storage.get(checkpointKey(sessionID, endedID)) !== undefined) {
									await setActiveCheckpoint(sessionID, endedID)
									log("compaction committed", { sessionID, checkpointID: endedID })
								}
							}
						} else if (event.type === "session.forked") {
							await copyForkCheckpoints(event.data.parentID, event.data.sessionID)
						} else if (event.type === "session.model.selected" && event.data.model.providerID !== "openai") {
							const durable = await ctx.session.context({ sessionID: event.data.sessionID })
							const compaction = [...durable].reverse().find((item) => item.type === "compaction" && item.status === "completed")
							const checkpointIDs = compaction && typeof compaction.summary === "string" ? markerIDs(compaction.summary) : []
							if (checkpointIDs.length > 1) throw new Error("native compaction summary contains multiple checkpoint markers")
							const checkpointID = checkpointIDs[0] ?? await activeCheckpointID(event.data.sessionID)
							if (!checkpointID) continue
							await ensureSwitchWarning(event.data.sessionID, checkpointID, event.data.model)
						} else if (event.type === "session.revert.committed") {
							await ctx.storage.remove(activeCheckpointKey(event.data.sessionID))
						} else if (event.type === "session.deleted") {
							const pending = sessions.get(event.data.sessionID)?.pending
							sessions.delete(event.data.sessionID)
							if (pending) await ctx.storage.remove(checkpointKey(event.data.sessionID, pending.checkpointID))
							await ctx.storage.remove(requestContextKey(event.data.sessionID))
							await ctx.storage.remove(activeCheckpointKey(event.data.sessionID))
						}
					} catch (error) {
						log("lifecycle event failed", {
							type: event.type,
							error: error instanceof Error ? error.message : String(error),
						})
					}
				}
			} catch (error) {
				if (!abort.signal.aborted) log("event listener failed", { error: error instanceof Error ? error.message : String(error) })
			}
		})()

		await ctx.session.hook("context", async (event) => {
			if (event.agent === "compaction" || event.model.providerID !== "openai") return
			const state = stateOf(event.sessionID)
			await hydrateRequestContext(event.sessionID, state)
			state.preserveRequestContext = shouldPreserveRequestContext({
				previousAgent: state.agent,
				previousTools: state.snapshot?.tools,
				agent: event.agent,
				tools: event.tools,
			})
			if (state.preserveRequestContext) return
			state.snapshot = {
				system: structuredClone(event.system),
				tools: structuredClone(event.tools) as ContextSnapshot["tools"],
			}
			state.model = copyModel(event.model)
			state.agent = event.agent
		})

		await ctx.session.hook("http.request", async (event) => {
			let parsed: unknown
			try {
				parsed = await event.request.clone().json()
			} catch {
				return
			}
			if (!isObject(parsed)) return

			const model = copyModel(event.model)
			const existingState = sessions.get(event.sessionID)
			const preserveRequestContext = existingState?.preserveRequestContext === true
			if (existingState) existingState.preserveRequestContext = false
			const activeID = await activeCheckpointID(event.sessionID)
			const bodyMarkers = activeID ? markerIDs(parsed) : []
			if (bodyMarkers.length > 1) throw new Error("native compaction request contains multiple checkpoint markers")
			const subscription = isOpenAISubscriptionRequest(event.request)
			if (bodyMarkers.length === 1 && (model.providerID !== "openai" || !responseBody(parsed) || !subscription)) {
				await readCheckpoint(event.sessionID, bodyMarkers[0]!)
				await setActiveCheckpoint(event.sessionID, bodyMarkers[0]!)
				await ensureSwitchWarning(event.sessionID, bodyMarkers[0]!, model)
				if (event.agent === "compaction") {
					throw new Error(`tail compaction requires switching back to the checkpoint model before compacting: ${modelKey(model)}`)
				}
				event.request = replaceJsonRequest(event.request, historyAfterMarker(parsed, bodyMarkers[0]!))
				log("native checkpoint omitted for incompatible model", {
					sessionID: event.sessionID,
					checkpointID: bodyMarkers[0]!,
					model: modelKey(model),
				})
				return
			}
			if (model.providerID !== "openai" || !responseBody(parsed) || !subscription) return

			const state = stateOf(event.sessionID)

			if (event.agent === "compaction") {
				await hydrateRequestContext(event.sessionID, state)
				if (!state.snapshot || !state.base || !state.model) {
					throw new Error("native compaction has no finalized normal request context")
				}
				if (modelKey(state.model) !== modelKey(model)) {
					throw new Error(`native compaction context requires ${modelKey(state.model)}`)
				}
				if (compactionHttpAction(state.pending) === "retry" && state.pending) {
					const pending = state.pending
					if (pending.phase === "committing") {
						log("native compaction retry replaying stored checkpoint", {
							sessionID: event.sessionID,
							checkpointID: pending.checkpointID,
						})
						return
					}
					const retryHeaders = new Headers(event.request.headers)
					mergeFeatureHeader(retryHeaders)
					try {
						event.request = replaceJsonRequest(event.request, nativeCompactionBody(state.base, pending.input), retryHeaders)
					} catch (error) {
						await discardUncommitted(event.sessionID, pending.checkpointID, "native compaction retry dispatch failed")
						throw error
					}
					log("native compaction retry dispatched", {
						sessionID: event.sessionID,
						checkpointID: pending.checkpointID,
					})
					return
				}
				const durableContext = await ctx.session.context({ sessionID: event.sessionID })
				const retainedTokenBudget = retainedTokenBudgetForDurable(durableContext)
				let encoded: ResponseItem[]
				try {
					encoded = await encodeDurableItems({ model, snapshot: state.snapshot, durable: durableContext })
				} catch (error) {
					if (activeID) throw error
					log("native compaction skipped for unsupported durable history", {
						sessionID: event.sessionID,
						error: error instanceof Error ? error.message : String(error),
					})
					return
				}
				const input = boundResponseImages(await inputWithActiveCheckpoint(encoded, event.sessionID, model))
				const checkpointID = crypto.randomUUID()
				state.pending = { checkpointID, model, input, retainedTokenBudget, phase: "response", createdAt: Date.now() }
				const headers = new Headers(event.request.headers)
				mergeFeatureHeader(headers)
				try {
					event.request = replaceJsonRequest(event.request, nativeCompactionBody(state.base, input), headers)
				} catch (error) {
					state.pending = undefined
					throw error
				}
				log("native compaction dispatched", { sessionID: event.sessionID, checkpointID })
				return
			}

			const input = boundResponseImages(await inputWithActiveCheckpoint(parsed.input, event.sessionID, model))
			const body = { ...parsed, input }
			const headers = new Headers(event.request.headers)
			mergeFeatureHeader(headers)
			event.request = replaceJsonRequest(event.request, body, headers)
			if (preserveRequestContext) return
			state.base = baseRequestBody(body)
			state.model = model
			if (!state.snapshot) throw new Error("native compaction cannot persist a request without its context snapshot")
			await ctx.storage.set(requestContextKey(event.sessionID), storageJson({
				version: 1,
				snapshot: state.snapshot,
				base: state.base,
				model: state.model,
				agent: state.agent,
			} satisfies DurableRequestContext))
		})

		await ctx.session.hook("http.response", async (event) => {
			if (event.agent !== "compaction" || event.model.providerID !== "openai") return
			const pending = sessions.get(event.sessionID)?.pending
			if (!pending) return
			if (pending.phase === "committing") {
				event.response = markerSSE(pending)
				log("native checkpoint replayed", { sessionID: event.sessionID, checkpointID: pending.checkpointID })
				return
			}
			try {
				const result = await parseNativeCompaction(event.response.clone())
				const checkpoint: NativeCheckpoint = {
					version: 1,
					sessionID: event.sessionID,
					model: pending.model,
					replacementHistory: replacementHistory(pending.input, result.item, pending.retainedTokenBudget),
					createdAt: Date.now(),
				}
				await ctx.storage.set(checkpointKey(event.sessionID, pending.checkpointID), storageJson(checkpoint))
				pending.phase = "committing"
				pending.usage = result.usage
				event.response = markerSSE(pending)
				log("native checkpoint stored", { sessionID: event.sessionID, checkpointID: pending.checkpointID })
			} catch (error) {
				await discardUncommitted(event.sessionID, pending.checkpointID, "native compaction response failed")
				throw error
			}
		})

		return () => {
			abort.abort()
			sessions.clear()
			switchWarnings.clear()
		}
	},
})
