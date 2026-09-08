import { isObject, modelKey, type ModelRef, type ResponseItem } from "./protocol"

export type NativeCheckpoint = {
	version: 1
	sessionID: string
	model: ModelRef
	replacementHistory: ResponseItem[]
	createdAt: number
}

export function checkpointKey(sessionID: string, checkpointID: string): string {
	return `checkpoint/${sessionID}/${checkpointID}`
}

export function checkpointPrefix(sessionID: string): string {
	return `checkpoint/${sessionID}/`
}

export function parseCheckpoint(value: unknown): NativeCheckpoint {
	if (!isObject(value) || value.version !== 1 || typeof value.sessionID !== "string" || !isObject(value.model)
		|| typeof value.model.providerID !== "string" || typeof value.model.id !== "string"
		|| !Array.isArray(value.replacementHistory) || value.replacementHistory.length === 0
		|| typeof value.createdAt !== "number") {
		throw new Error("native compaction checkpoint is malformed")
	}
	const history = value.replacementHistory
	const last = history.at(-1)
	const compactions = history.filter((item) => isObject(item) && item.type === "compaction")
	if (!history.every(isObject) || compactions.length !== 1 || !isObject(last) || last.type !== "compaction"
		|| typeof last.encrypted_content !== "string" || last.encrypted_content.length === 0) {
		throw new Error("native compaction replacement history is malformed")
	}
	return value as NativeCheckpoint
}

export function requireCompatible(checkpoint: NativeCheckpoint, sessionID: string, model: ModelRef): void {
	if (checkpoint.sessionID !== sessionID) throw new Error("native compaction checkpoint belongs to another session")
	if (modelKey(checkpoint.model) !== modelKey(model)) {
		throw new Error(`native compaction checkpoint requires ${modelKey(checkpoint.model)}`)
	}
}
