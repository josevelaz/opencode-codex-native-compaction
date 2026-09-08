import { checkpointMarker, markerIDs } from "./protocol"

export type PendingPhase = "response" | "committing"

export type PendingAttempt = {
	checkpointID: string
	phase: PendingPhase
	createdAt: number
}

export function compactionHttpAction(pending: PendingAttempt | undefined): "begin" | "retry" {
	return pending ? "retry" : "begin"
}

export function terminalEventTargetsAttempt(
	pending: PendingAttempt | undefined,
	eventCreated?: number,
): boolean {
	if (!pending) return false
	if (eventCreated === undefined) return true
	return eventCreated >= pending.createdAt
}

export function summaryCommitsCheckpoint(text: string, checkpointID: string): boolean {
	const ids = markerIDs(text)
	if (ids.length > 1) return false
	return ids[0] === checkpointID || text.includes(checkpointMarker(checkpointID))
}

export function shouldDiscardCheckpoint(input: {
	checkpointID: string
	activeID?: string
	hostCommitted: boolean
}): boolean {
	if (input.hostCommitted) return false
	if (input.activeID === input.checkpointID) return false
	return true
}
