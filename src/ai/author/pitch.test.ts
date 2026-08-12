import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "../../config.js";

/**
 * Four worlds to choose between, before one is paid for.
 *
 * With nothing typed the lore pass invents a premise silently, four minutes in — so the
 * first thing a player learns about the world they bought is that they did not choose it.
 * This is one cheap call that turns that into a decision.
 *
 * Nothing here is load-bearing: a failed call returns nothing and the page it feeds falls
 * back to the player typing their own, which is what they would have done anyway.
 */

const structured = vi.fn();
vi.mock("../client.js", () => ({
	structured: (...args: unknown[]) => structured(...args),
}));

const { suggestPitches } = await import("./pitch.js");

const FOUR = {
	pitches: [
		{ title: "The Tide-Glass", tone: "sombre", premise: "A drowned archipelago." },
		{ title: "The Ledger of Saint Wain", tone: "wry", premise: "A monastery audits miracles." },
		{ title: "Nine Years at the Gate", tone: "weary", premise: "A siege nobody remembers." },
		{ title: "The Salt Road", tone: "hard", premise: "The caravans have stopped coming." },
	],
};

beforeEach(() => {
	structured.mockReset();
});

describe("suggesting a premise", () => {
	it("asks the prose model, because the player reads every word of these", async () => {
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "medium" });

		const request = structured.mock.calls[0]?.[0] as { model: string; kind: string };
		// The fast model does the bookkeeping nobody reads; this is the other kind of call.
		// Asserted against `MODELS.bible` rather than a model id, because the catalogue's
		// default row moves and the claim here is about the tier, not about the vendor.
		expect(request.model).toBe(MODELS.bible);
		expect(request.kind).toBe("pitch");
	});

	it("hands back the bundles it was given", async () => {
		structured.mockResolvedValue(FOUR);
		const pitches = await suggestPitches({ duration: "medium" });
		expect(pitches).toHaveLength(4);
		expect(pitches[0]?.title).toBe("The Tide-Glass");
		expect(pitches[0]?.tone).toBe("sombre");
	});

	it("returns nothing rather than throwing when the call fails", async () => {
		// The contract every caller of `structured` keeps. The page falls back to the player
		// typing their own, which is what they would have done without this at all.
		structured.mockResolvedValue(undefined);
		expect(await suggestPitches({ duration: "medium" })).toEqual([]);
	});

	it("puts what the player has already typed in front of the model", async () => {
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "short", hint: "something about debt" });

		const request = structured.mock.calls[0]?.[0] as { prompt: string };
		expect(request.prompt).toContain("something about debt");
	});

	it("tells the model what it has already offered, so 'more' means more", async () => {
		// Without this the second press returns four near-copies of the first four, and the
		// key reads as broken rather than as a model with no memory between calls.
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "short", avoid: ["The Tide-Glass"] });

		const request = structured.mock.calls[0]?.[0] as { prompt: string };
		expect(request.prompt).toContain("The Tide-Glass");
	});

	it("says how long the world will be, since that changes what fits in one", async () => {
		structured.mockResolvedValue(FOUR);
		await suggestPitches({ duration: "tiny" });

		const request = structured.mock.calls[0]?.[0] as { prompt: string };
		expect(request.prompt).toContain("tiny");
	});
});
