import { describe, expect, test } from "bun:test"
import { checkpointKey, parseCheckpoint, requireCompatible } from "./state"

const checkpoint = {
	version: 1 as const,
	sessionID: "session",
	model: { providerID: "openai", id: "gpt-5.3-codex-spark", variant: "low" },
	replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
	createdAt: 1,
}

describe("checkpoint state", () => {
	test("validates durable checkpoints", () => {
		expect(parseCheckpoint(checkpoint)).toEqual(checkpoint)
		expect(() => parseCheckpoint({ ...checkpoint, version: 2 })).toThrow("malformed")
		expect(() => parseCheckpoint({ ...checkpoint, replacementHistory: [] })).toThrow("malformed")
		expect(() => parseCheckpoint({
			...checkpoint,
			replacementHistory: [{ type: "compaction", encrypted_content: "" }],
		})).toThrow("malformed")
		expect(() => parseCheckpoint({
			...checkpoint,
			replacementHistory: [
				{ type: "compaction", encrypted_content: "one" },
				{ type: "compaction", encrypted_content: "two" },
			],
		})).toThrow("malformed")
	})

	test("requires the same session and exact model variant", () => {
		expect(() => requireCompatible(checkpoint, "other", checkpoint.model)).toThrow("another session")
		expect(() => requireCompatible(checkpoint, "session", { ...checkpoint.model, variant: "high" })).toThrow("requires")
		expect(() => requireCompatible(checkpoint, "session", checkpoint.model)).not.toThrow()
	})

	test("uses session-scoped storage keys", () => {
		expect(checkpointKey("session", "checkpoint")).toBe("checkpoint/session/checkpoint")
	})
})
