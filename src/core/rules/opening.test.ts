import { describe, expect, it } from "vitest";
import type { RegionSpec, WorldLore } from "../world/spec.js";
import type { ScenarioArc } from "./arc.js";
import { openingCard } from "./opening.js";

/**
 * The opening card, for each of the three ways a world can come to exist.
 *
 * The property that matters across all of them: every part is optional, and a part
 * nobody supplied must produce no heading rather than an empty one. A procedural
 * world with no brief and no arc is the thinnest case and still has to read as
 * deliberate.
 */

const LORE: WorldLore = {
	title: "The Long Weather",
	premise: "The old roads still run between the holdfasts.",
	era: "the late years of a long decline",
	tone: "weatherbeaten",
	factions: ["the Roadwardens"],
	deities: ["the Patient Sister"],
};

const REGION: RegionSpec = {
	id: "1",
	name: "The Long Fell",
	blurb: "Deep forest cut by one road.",
	tone: "damp",
	culture: "fellers",
	lore: [],
	ambient: [],
};

const ARC: ScenarioArc = {
	title: "The Hollow Tithe",
	premise: "Your sister took the warden's badge and stopped writing.",
	beats: [],
};

function headings(card: { sections: readonly { heading: string }[] }): string[] {
	return card.sections.map((section) => section.heading);
}

function body(card: { sections: readonly { heading: string; body: string }[] }, heading: string) {
	return card.sections.find((section) => section.heading === heading)?.body ?? "";
}

describe("the opening card", () => {
	it("titles itself from the world, not from the story", () => {
		// The story's own title belongs to the journal, where progress is counted.
		const card = openingCard({ lore: LORE, arc: ARC });
		expect(card.title).toBe("The Long Weather");
		expect(card.subtitle).toBe("the late years of a long decline");
	});

	it("shows all three questions when everything is known", () => {
		const card = openingCard({
			lore: LORE,
			region: REGION,
			placeName: "Bracken Cross",
			landscape: "old forest",
			brief: { protagonist: "a timber-tallier walking the road out of season" },
			arc: ARC,
		});
		expect(headings(card)).toEqual(["Where you are", "Who you are", "What brought you here"]);
	});

	it("zooms in: world, then region, then the town", () => {
		const where = body(
			openingCard({ lore: LORE, region: REGION, placeName: "Bracken Cross" }),
			"Where you are",
		);
		expect(where.indexOf("holdfasts")).toBeLessThan(where.indexOf("Bracken Cross"));
		expect(where).toContain("in The Long Fell");
		expect(where).toContain("Deep forest cut by one road.");
	});

	it("falls back to the landscape when no region has been named", () => {
		// Which is every procedural world: the fallback director names sites but never
		// regions, so there is nothing to quote and the ground has to speak instead.
		const where = body(openingCard({ lore: LORE, landscape: "salt marsh" }), "Where you are");
		expect(where).toContain("salt marsh");
	});

	it("does not repeat itself when a region blurb already sets the scene", () => {
		const where = body(
			openingCard({ lore: LORE, region: REGION, landscape: "old forest" }),
			"Where you are",
		);
		expect(where).not.toContain("old forest");
	});

	it("addresses the player, turning the brief's third person around", () => {
		const who = body(
			openingCard({ lore: LORE, brief: { protagonist: "a timber-tallier out of season" } }),
			"Who you are",
		);
		expect(who).toBe("You are a timber-tallier out of season.");
	});

	it("says something rather than nothing when nobody wrote a protagonist", () => {
		const who = body(openingCard({ lore: LORE }), "Who you are");
		expect(who).toContain("traveller on foot");
	});

	it("prefers the arc's premise over the brief's storyline", () => {
		// Both describe the same story, but the arc is the one the game will actually
		// hold the player to — its beats are what open and close.
		const card = openingCard({
			lore: LORE,
			arc: ARC,
			brief: { storyline: "the player is looking for a sibling" },
		});
		expect(body(card, "What brought you here")).toBe(ARC.premise);
	});

	it("uses the storyline when there is no arc, which is every live world", () => {
		const what = body(
			openingCard({ lore: LORE, brief: { storyline: "the player is looking for a sibling" } }),
			"What brought you here",
		);
		expect(what).toBe("You are looking for a sibling.");
	});

	it("admits to having no errand rather than inventing one", () => {
		// A procedural world has no arc to keep a promise with, so promising nothing is
		// the only honest option — and it still frames the game as the player's choice.
		const what = body(openingCard({ lore: LORE }), "What brought you here");
		expect(what).toContain("Nothing in particular");
	});

	it("drops a heading whose body would be empty", () => {
		const card = openingCard({ lore: { ...LORE, premise: "" } });
		expect(headings(card)).not.toContain("Where you are");
		expect(card.sections.every((section) => section.body.trim().length > 0)).toBe(true);
	});

	it("is shown once, by id", () => {
		expect(openingCard({ lore: LORE }).id).toBe("opening");
	});

	it("says where to start, which is the only line that answers 'so what now'", () => {
		const what = body(
			openingCard({
				lore: LORE,
				arc: ARC,
				start: {
					place: "Bracken Cross",
					person: "Ilse Marrow",
					bearing: "to the west",
					distance: 150,
				},
			}),
			"Where to start",
		);
		expect(what).toContain("Bracken Cross lies to the west");
		expect(what).toContain("a fair walk");
		expect(what).toContain("Ask for Ilse Marrow");
		// And tells them where the game will keep reminding them.
		expect(what).toContain("marked on the map");
	});

	it("turns tiles into a decision rather than a number to endure", () => {
		const at = (distance: number) =>
			body(
				openingCard({ lore: LORE, start: { place: "X", bearing: "to the north", distance } }),
				"Where to start",
			);
		expect(at(20)).toContain("a few minutes' walk");
		expect(at(150)).toContain("a fair walk");
		expect(at(400)).toContain("a long way off");
	});

	it("still points somewhere when nobody in particular is waiting", () => {
		const what = body(
			openingCard({ lore: LORE, start: { place: "Bracken Cross" } }),
			"Where to start",
		);
		expect(what).toContain("Make for Bracken Cross");
	});

	it("points nowhere rather than at a random town when there is no story", () => {
		// Every live and procedural world. Naming a place would be a promise nothing
		// keeps, and the player would walk a long way to find out.
		const card = openingCard({ lore: LORE });
		expect(headings(card)).not.toContain("Where to start");
	});
});
