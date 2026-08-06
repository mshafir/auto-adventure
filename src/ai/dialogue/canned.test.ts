import { describe, expect, it } from "vitest";
import { createNpcRecord } from "../../core/rules/npc.js";
import type { NpcSpec, SiteSpec } from "../../core/world/spec.js";
import { cannedTurn } from "./canned.js";

/**
 * The conversation everybody without a written tree has.
 *
 * It is a menu, and a menu is matched back by the text of the entry the player chose —
 * so two entries reading the same are not a cosmetic wart. The second is unreachable,
 * and the answer the player gets is always the first one's.
 */

const RECORD = createNpcRecord({ id: "npc:1:0", name: "Wren", role: "miller", siteId: 1 });

function spec(knows: readonly string[] = []): NpcSpec {
	return {
		slot: 0,
		name: "Wren",
		role: "miller",
		glyph: "M",
		appearance: "Flour to the elbow.",
		persona: "Brisk.",
		disposition: 0,
		placement: "doorstep",
		knows: [...knows],
	};
}

function site(hooks: readonly string[]): SiteSpec {
	return {
		siteId: 1,
		name: "Harrowfen",
		shortName: "Harrowfen",
		description: "A mill, a green and a great deal of water.",
		settlement: { name: "Harrowfen", walled: false, structures: [] },
		npcs: [],
		hooks: [...hooks],
	};
}

describe("a canned conversation", () => {
	it("does not offer the same choice twice when a place has two hooks", () => {
		// Every hook used to become the literal entry "Ask what troubles the town.", so a
		// site with two of them showed it twice and only ever answered with the first.
		const two = site([
			"The mooring iron is somewhere in the reeds.",
			"There is an old woman at the fire nobody names.",
		]);
		const turn = cannedTurn(RECORD, spec(), two, undefined);
		expect(new Set(turn.choices).size).toBe(turn.choices.length);
	});

	it("can be asked about either of them, and answers each with its own hook", () => {
		const hooks = [
			"The mooring iron is somewhere in the reeds.",
			"There is an old woman at the fire nobody names.",
		];
		const turn = cannedTurn(RECORD, spec(), site(hooks), undefined);
		const answers = turn.choices
			.filter((choice) => choice !== "Farewell.")
			.map((choice) => cannedTurn(RECORD, spec(), site(hooks), choice).speech);
		for (const hook of hooks) expect(answers).toContain(hook);
	});

	it("never repeats itself, whatever the material compresses to", () => {
		// Two facts opening with the same six words collide exactly as two hooks did.
		const twins = spec([
			"The fens are rising again this year, they say.",
			"The fens are rising again, and the wardens are out.",
		]);
		const turn = cannedTurn(RECORD, twins, site([]), undefined);
		expect(new Set(turn.choices).size).toBe(turn.choices.length);
	});
});
