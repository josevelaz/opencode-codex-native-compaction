import { describe, expect, test } from "bun:test"
import { replacementHistory } from "./history"

const compaction = { type: "compaction", encrypted_content: "opaque" }

describe("replacement history", () => {
	test("keeps newest eligible input and puts the opaque item last", () => {
		const history = replacementHistory([
			{ role: "user", content: "old text" },
			{ type: "reasoning", encrypted_content: "reasoning" },
			{ role: "developer", content: [{ type: "input_text", text: "new text" }] },
		], compaction, 2)
		expect(history).toEqual([
			{ role: "developer", content: [{ type: "input_text", text: "new text" }] },
			compaction,
		])
	})

	test("rejects an invalid compaction item", () => {
		expect(() => replacementHistory([], { type: "compaction" })).toThrow("invalid compaction item")
	})
})
