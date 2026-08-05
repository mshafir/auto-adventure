import { describe, expect, it } from "vitest";
import { hashString } from "../../rand/hash.js";
import { TFlag } from "../../tiles/flags.js";
import { T } from "../../tiles/terrain.js";
import { clearInteriorCache, getComplex, type Interior } from "./interior.js";

const SEED = hashString("complex-test");

function walkable(level: Interior, from: { x: number; y: number }): Set<string> {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length) {
		const at = stack.pop() as { x: number; y: number };
		const key = `${at.x},${at.y}`;
		if (seen.has(key)) continue;
		if (at.x < 0 || at.y < 0 || at.x >= level.width || at.y >= level.height) continue;
		if (!((level.flags[at.y * level.width + at.x] ?? 0) & TFlag.Passable)) continue;
		seen.add(key);
		stack.push(
			{ x: at.x + 1, y: at.y },
			{ x: at.x - 1, y: at.y },
			{ x: at.x, y: at.y + 1 },
			{ x: at.x, y: at.y - 1 },
		);
	}
	return seen;
}

describe("a building with storeys", () => {
	const levels = getComplex(SEED, 4242, "tower");

	it("has one level per floor in the plan", () => {
		expect(levels).toHaveLength(3);
		expect(levels.map((level) => level.level)).toEqual([0, 1, 2]);
	});

	it("puts the outside door only on the ground floor", () => {
		expect([...(levels[0] as Interior).terrain]).toContain(T.doorOpen);
		expect([...(levels[1] as Interior).terrain]).not.toContain(T.doorOpen);
		expect([...(levels[2] as Interior).terrain]).not.toContain(T.doorOpen);
	});

	it("lines the stairs up between neighbouring levels", () => {
		// The reason a complex is generated as a whole. Two generators agreeing on a
		// coordinate afterwards is a bug waiting for the fifth building in the fifth
		// town; one generator deciding it once cannot disagree with itself.
		//
		// Paired by target level rather than by direction, because a tower goes up as
		// the index rises and a cave goes down — which is exactly the confusion that
		// sent everyone who climbed a tower to level minus one.
		for (let i = 0; i + 1 < levels.length; i++) {
			const out = (levels[i] as Interior).portals.find((p) => p.to === i + 1);
			const back = (levels[i + 1] as Interior).portals.find((p) => p.to === i);
			expect(out, `level ${i} has no way to ${i + 1}`).toBeDefined();
			expect(back, `level ${i + 1} has no way back`).toBeDefined();
			expect({ x: out?.x, y: out?.y }).toEqual({ x: back?.x, y: back?.y });
			// In a building the index rises as you climb.
			expect(out?.kind).toBe("up");
			expect(back?.kind).toBe("down");
		}
	});

	it("never puts the up and down stairs on the same tile", () => {
		// The middle storey of a tower has both. Sharing a tile would mean arriving on
		// the stair that sends you straight back where you came from.
		const middle = levels[1] as Interior;
		const up = middle.portals.find((p) => p.to === 2);
		const down = middle.portals.find((p) => p.to === 0);
		expect(up).toBeDefined();
		expect(down).toBeDefined();
		expect(`${up?.x},${up?.y}`).not.toBe(`${down?.x},${down?.y}`);
	});

	it("leaves every stair standable and reachable from the way in", () => {
		for (const level of levels) {
			const from =
				level.level === 0 ? level.entrance : (level.portals[0] as { x: number; y: number });
			const reached = walkable(level, from);
			for (const portal of level.portals) {
				expect(
					reached.has(`${portal.x},${portal.y}`),
					`level ${level.level} stair walled off`,
				).toBe(true);
			}
		}
	});

	it("furnishes the storeys differently", () => {
		const ground = [...(levels[0] as Interior).decor].join(",");
		const above = [...(levels[1] as Interior).decor].join(",");
		expect(above).not.toBe(ground);
	});

	it("leaves a single-storey building exactly as it was", () => {
		const shop = getComplex(SEED, 99, "shop");
		expect(shop).toHaveLength(1);
		expect((shop[0] as Interior).portals).toEqual([]);
	});

	it("is generated once and served thereafter", () => {
		expect(getComplex(SEED, 4242, "tower")).toBe(levels);
		clearInteriorCache();
		const again = getComplex(SEED, 4242, "tower");
		expect(again).not.toBe(levels);
		// Same world, same building: the rooms have to come back identical.
		expect([...(again[2] as Interior).decor]).toEqual([...(levels[2] as Interior).decor]);
	});
});

describe("a cave", () => {
	const levels = getComplex(SEED, 77, "cave");

	it("goes down several levels", () => {
		expect(levels.length).toBeGreaterThanOrEqual(3);
	});

	it("is rock with rooms eaten out of it, not a rectangular room", () => {
		const ground = levels[0] as Interior;
		let floor = 0;
		let rock = 0;
		for (const id of ground.terrain) {
			if (id === T.caveFloor) floor++;
			if (id === T.caveWall) rock++;
		}
		expect(floor).toBeGreaterThan(40);
		// Most of the volume is still rock. A cave that is mostly floor is a room.
		expect(rock).toBeGreaterThan(floor);
	});

	it("connects every stair to the way in", () => {
		// Carved from the entrance *toward* each stair rather than carved and then
		// checked, so this holds by construction — and a sealed chamber with the only
		// chest in it is not a bug a player can report.
		for (const level of levels) {
			const from =
				level.level === 0
					? level.entrance
					: (level.portals.find((p) => p.to === level.level - 1) as { x: number; y: number });
			const reached = walkable(level, from);
			for (const portal of level.portals) {
				expect(reached.has(`${portal.x},${portal.y}`), `cave level ${level.level}`).toBe(true);
			}
		}
	});

	it("puts something worth finding at the bottom", () => {
		const deepest = levels[levels.length - 1] as Interior;
		let things = 0;
		for (const id of deepest.decor) if (id !== 0) things++;
		expect(things).toBeGreaterThan(0);
	});
});
