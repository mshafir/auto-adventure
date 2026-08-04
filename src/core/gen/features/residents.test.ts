import { describe, expect, it } from "vitest";
import { hashString } from "../../rand/hash.js";
import { isContainer } from "../../rules/loot.js";
import { TFlag } from "../../tiles/flags.js";
import { getInterior } from "./interior.js";
import type { StructureKind } from "./patch.js";
import { isResidentId, residentId, residentsOf } from "./residents.js";

const SEED = hashString("residents-test");

function peopleIn(kind: StructureKind, interiorId = 1234) {
	const interior = getInterior(SEED, interiorId, kind);
	return { interior, people: residentsOf(SEED, interiorId, kind, interior) };
}

describe("who is inside a building", () => {
	it("puts somebody in a house", () => {
		expect(peopleIn("house").people.length).toBeGreaterThan(0);
	});

	it("fills the rooms worth walking into", () => {
		// Not realism — a barracks with nobody in it is a disappointment, and these are
		// the kinds a player is most likely to open a door on twice.
		for (const kind of ["inn", "barracks", "smithy", "temple", "mill"] as const) {
			expect(peopleIn(kind).people.length, `${kind} is empty`).toBeGreaterThan(0);
		}
	});

	it("leaves a ruin to itself", () => {
		expect(peopleIn("ruin").people).toEqual([]);
	});

	it("is the same house every time it is asked", () => {
		// Residents are never stored, so this is the only thing making them survive
		// eviction, a reload, or a second world opened in the same process.
		const first = peopleIn("house", 9001).people;
		const second = peopleIn("house", 9001).people;
		expect(second.map((p) => `${p.id}:${p.name}:${p.x},${p.y}`)).toEqual(
			first.map((p) => `${p.id}:${p.name}:${p.x},${p.y}`),
		);
	});

	it("gives two buildings different people", () => {
		const a = peopleIn("house", 11).people.map((p) => p.name);
		const b = peopleIn("house", 12).people.map((p) => p.name);
		expect(a).not.toEqual(b);
	});

	it("namespaces ids away from a site's own people", () => {
		// A site's npc id is `npc:{siteId}:{slot}`, and site ids and interior ids are
		// both hashes — so without the namespace one could collide with the other and
		// two different people would share a memory record.
		const id = residentId(4242, 0);
		expect(id).toBe("npc:in:4242:0");
		expect(isResidentId(id)).toBe(true);
		expect(isResidentId("npc:4242:0")).toBe(false);
	});

	it("stands everyone on floor they can be reached on", () => {
		for (const kind of ["house", "inn", "barracks", "temple", "shop"] as const) {
			const { interior, people } = peopleIn(kind);
			for (const person of people) {
				const i = person.y * interior.width + person.x;
				expect(
					Boolean((interior.flags[i] ?? 0) & TFlag.Interior),
					`${person.name} is not on interior floor in a ${kind}`,
				).toBe(true);
			}
		}
	});

	it("never blocks the doorway", () => {
		// Walking into somebody talks to them instead of stepping, so a resident in the
		// entrance would greet the player before they saw the room — and in a one-tile
		// corridor could not be walked around at all.
		for (const kind of ["house", "inn", "shop", "smithy", "barracks", "mill"] as const) {
			const { interior, people } = peopleIn(kind);
			for (const person of people) {
				const inDoorColumn = person.x === interior.entrance.x;
				expect(
					inDoorColumn && person.y >= interior.entrance.y - 1,
					`${person.name} is standing in the doorway of a ${kind}`,
				).toBe(false);
			}
		}
	});

	it("never sits on a container the player was sent to search", () => {
		for (const kind of ["house", "inn", "shop", "warehouse", "smithy"] as const) {
			const { interior, people } = peopleIn(kind);
			for (const person of people) {
				const decor = interior.decor[person.y * interior.width + person.x] ?? 0;
				expect(isContainer(decor), `${person.name} is sitting on a container`).toBe(false);
			}
		}
	});

	it("never stacks two people on one tile", () => {
		for (const kind of ["inn", "barracks", "house", "temple"] as const) {
			const { people } = peopleIn(kind);
			const spots = new Set(people.map((p) => `${p.x},${p.y}`));
			expect(spots.size, `two people share a tile in a ${kind}`).toBe(people.length);
		}
	});

	it("numbers slots from zero without gaps, so ids are predictable", () => {
		const people = peopleIn("inn").people;
		expect(people.map((p) => p.spec.slot)).toEqual(people.map((_, index) => index));
	});

	it("gives everyone the shape the dialogue layer expects", () => {
		for (const person of peopleIn("house").people) {
			expect(person.name.length).toBeGreaterThan(0);
			expect(person.role.length).toBeGreaterThan(0);
			expect(person.glyph).toMatch(/^[A-Z]$/);
			expect(person.spec.appearance.length).toBeGreaterThan(0);
			expect(person.spec.persona.length).toBeGreaterThan(0);
		}
	});
});
