import { describe, expect, test } from "bun:test"
import { checkpointMarker, hostCheckpointSummary } from "./protocol"
import {
	compactionHttpAction,
	shouldDiscardCheckpoint,
	summaryCommitsCheckpoint,
	terminalEventTargetsAttempt,
} from "./pending"

const CHECKPOINT_ID = "12345678-1234-4234-9234-123456789abc"

describe("pending compaction attempts", () => {
	test("treats a second HTTP request as a retry of the open attempt", () => {
		expect(compactionHttpAction(undefined)).toBe("begin")
		expect(compactionHttpAction({ checkpointID: CHECKPOINT_ID, phase: "response", createdAt: 1 })).toBe("retry")
		expect(compactionHttpAction({ checkpointID: CHECKPOINT_ID, phase: "committing", createdAt: 1 })).toBe("retry")
	})

	test("ignores delayed terminal events for a newer attempt", () => {
		const pending = { checkpointID: CHECKPOINT_ID, phase: "response" as const, createdAt: 100 }
		expect(terminalEventTargetsAttempt(undefined, 100)).toBe(false)
		expect(terminalEventTargetsAttempt(pending, 99)).toBe(false)
		expect(terminalEventTargetsAttempt(pending, 100)).toBe(true)
		expect(terminalEventTargetsAttempt(pending, undefined)).toBe(true)
	})

	test("commits wrapped and bare markers for the owning checkpoint", () => {
		expect(summaryCommitsCheckpoint(hostCheckpointSummary(CHECKPOINT_ID), CHECKPOINT_ID)).toBe(true)
		expect(summaryCommitsCheckpoint(checkpointMarker(CHECKPOINT_ID), CHECKPOINT_ID)).toBe(true)
		expect(summaryCommitsCheckpoint("## Objective\n- continue", CHECKPOINT_ID)).toBe(false)
		expect(summaryCommitsCheckpoint(hostCheckpointSummary("12345678-1234-4234-8234-123456789abc"), CHECKPOINT_ID)).toBe(false)
	})

	test("preserves a committed or active checkpoint and discards only uncommitted data", () => {
		expect(shouldDiscardCheckpoint({ checkpointID: CHECKPOINT_ID, hostCommitted: true })).toBe(false)
		expect(shouldDiscardCheckpoint({ checkpointID: CHECKPOINT_ID, activeID: CHECKPOINT_ID, hostCommitted: false })).toBe(false)
		expect(shouldDiscardCheckpoint({ checkpointID: CHECKPOINT_ID, activeID: "other", hostCommitted: false })).toBe(true)
		expect(shouldDiscardCheckpoint({ checkpointID: CHECKPOINT_ID, hostCommitted: false })).toBe(true)
	})
})
