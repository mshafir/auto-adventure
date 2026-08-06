import { describe, expect, it } from "vitest";
import { DEFAULT_PACK } from "../core/content/default.js";
import { getComplex } from "../core/gen/features/interior.js";
import { standingRoom } from "../core/gen/features/residents.js";
import { hashString } from "../core/rand/hash.js";
import type { NpcSpec } from "../core/world/spec.js";
import { InteriorPeople } from "./interior-people.js";

/**
 * Who is in a room, and on which storey of it.
 *
 * Two things this covers, and they are the two halves of the same oversight. A
 * resident's position is local to a *grid*, and a building with three levels is three
 * grids that happen to share an id — so a roster that ignored the level drew the ground
 * floor's cook on every storey. And nothing a *scenario* wrote could be in a room at
 * all: the indoor cast existed, with ids and memory and dialogue, and there was no way
 * to put anybody into it.
 */

const SEED = hashString("indoors-test");
const INTERIOR = 4242;

function spec(name: string, slot = 0): NpcSpec {
	return {
		slot,
		name,
		role: "lady",
		glyph: "L",
		appearance: "Very fair, and standing between you and the door.",
		persona: "Tests people for sport.",
		disposition: 20,
		placement: "doorstep",
		knows: [],
		indoors: true,
	};
}

describe("a household on more than one storey", () => {
	it("does not put the ground floor's people upstairs", () => {
		// The bug: `personAt` ignored `inside.level` while the *view* honoured it, so the
		// cook from the kitchen was drawn in the guest room above her, standing at
		// coordinates that mean something entirely different up there.
		const people = new InteriorPeople(SEED, DEFAULT_PACK);
		const levels = getComplex(SEED, INTERIOR, "inn");
		expect(levels.length).toBeGreaterThan(1);

		const ground = people.in(INTERIOR, "inn", 0);
		const above = people.in(INTERIOR, "inn", 1);
		const ids = new Set(ground.map((person) => person.id));
		for (const person of above) expect(ids.has(person.id)).toBe(false);
	});

	it("gives the ground floor the ids it has always had", () => {
		// An id is what a remembered conversation is filed under. Renaming one turns
		// somebody the player has already met into a stranger with the same face.
		const people = new InteriorPeople(SEED, DEFAULT_PACK);
		for (const person of people.in(INTERIOR, "inn", 0)) {
			expect(person.id).toMatch(new RegExp(`^npc:in:${INTERIOR}:\\d+$`));
		}
	});
});

describe("somebody a scenario put in a room", () => {
	function withLady() {
		return new InteriorPeople(SEED, DEFAULT_PACK, (_id, level) =>
			level === 0 ? [{ id: "npc:99:1", spec: spec("the Lady of Hautdesert") }] : [],
		);
	}

	it("stands in the room, keeping the id the site gave them", () => {
		// The whole trick. Their id is the one they would have had outdoors, so a beat
		// anchored to them, a dialogue tree written for them and a `talk` objective
		// naming them all work with no new machinery at all.
		const people = withLady();
		const room = people.in(INTERIOR, "house", 0);
		const lady = room.find((person) => person.id === "npc:99:1");
		expect(lady?.name).toBe("the Lady of Hautdesert");
		expect(lady).toBeDefined();
		if (!lady) return;
		expect(people.at(INTERIOR, "house", lady.x, lady.y, 0)?.id).toBe("npc:99:1");
		expect(people.byId(INTERIOR, "house", "npc:99:1", 0)?.name).toBe("the Lady of Hautdesert");
	});

	it("is not stood on by the household that fills in around them", () => {
		const people = withLady();
		const room = people.in(INTERIOR, "house", 0);
		const seen = new Set<string>();
		for (const person of room) {
			const key = `${person.x},${person.y}`;
			expect(seen.has(key), `two people on ${key}`).toBe(false);
			seen.add(key);
		}
	});

	it("stands them where the room's life is, not in the first corner", () => {
		// Blocking, not decoration. Row-major order put the lady in the top-left corner
		// of her own bower while her opening line invited the player to sit down by the
		// fire — and a scene where the only person in it is standing in a corner behind
		// the player reads as an empty room.
		const people = withLady();
		const interior = getComplex(SEED, INTERIOR, "house")[0];
		if (!interior) throw new Error("no ground floor");
		const hearth = interior.anchors.find((anchor) => anchor.kind === "hearth");
		if (!hearth) return; // Nothing to prefer; the order is left alone on purpose.

		const lady = people.in(INTERIOR, "house", 0).find((person) => person.id === "npc:99:1");
		if (!lady) throw new Error("the lady is not in the room");
		const reach = Math.hypot(lady.x - hearth.x, lady.y - hearth.y);
		for (const spot of standingRoom(interior)) {
			expect(Math.hypot(spot.x - hearth.x, spot.y - hearth.y)).toBeGreaterThanOrEqual(reach - 1e-9);
		}
	});

	it("is only on the storey the outside door opens onto", () => {
		// Ground floor on purpose: it is the one a beat can promise the player reaches,
		// because it is the one the door leads to.
		const people = withLady();
		const above = people.in(INTERIOR, "house", 1);
		expect(above.some((person) => person.id === "npc:99:1")).toBe(false);
	});
});
