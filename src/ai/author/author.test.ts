import { describe, expect, it } from "vitest";
import { bindLore } from "./author.js";

/**
 * Whose world it is.
 *
 * The lore pass is asked to keep a title the player chose, and asking is not enough: a
 * model told to preserve a field preserves it most of the time, and the times it does not
 * are a player who picked a world by its name being overruled by a machine on the one
 * decision they made before paying for it. So the answer is overwritten rather than
 * trusted, and this is the rule stated where it can be read.
 */

const WRITTEN = {
	title: "Something Else Entirely",
	premise: "The tide came in and did not go out.",
	era: "late bronze",
	tone: "jaunty",
	factions: ["the collectors", "the glassmen"],
	deities: ["the drowned saint"],
};

describe("binding the lore to what the player chose", () => {
	it("keeps the player's title and tone over whatever came back", () => {
		const lore = bindLore(WRITTEN, { title: "The Tide-Glass", tone: "sombre" });
		expect(lore.title).toBe("The Tide-Glass");
		expect(lore.tone).toBe("sombre");
	});

	it("leaves everything else to the model, including how it phrased the premise", () => {
		// The binding is two fields, not a takeover. The era, the factions, the deities and
		// the premise as written are the pass's own work and stay that way.
		const lore = bindLore(WRITTEN, { title: "The Tide-Glass" });
		expect(lore.premise).toBe(WRITTEN.premise);
		expect(lore.era).toBe(WRITTEN.era);
		expect(lore.factions).toEqual(WRITTEN.factions);
		// Tone was not chosen, so it is still the model's.
		expect(lore.tone).toBe("jaunty");
	});

	it("changes nothing at all for a world nobody named", () => {
		expect(bindLore(WRITTEN, { premise: "A drowned archipelago." })).toEqual(WRITTEN);
		expect(bindLore(WRITTEN, undefined)).toEqual(WRITTEN);
	});

	it("ignores a title that is only whitespace", () => {
		// Briefs arrive from environment variables and text fields, so a blank one has to
		// read as silence rather than as an instruction to call the world "".
		expect(bindLore(WRITTEN, { title: "   " }).title).toBe(WRITTEN.title);
	});
});
