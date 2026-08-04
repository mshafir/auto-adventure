import { describe, expect, it } from "vitest";
import { T, type TerrainId } from "../../core/tiles/terrain.js";
import { type Cell, composeScene, type TileSource } from "./compose.js";

/**
 * A tile source backed by a literal map, so each test states the exact terrain
 * arrangement it is asserting about.
 */
function sourceFrom(options: {
	terrain?: (x: number, y: number) => TerrainId;
	elevation?: (x: number, y: number) => number;
	player?: readonly [number, number];
}): TileSource {
	const base: TileSource = {
		terrainAt: (x, y) => options.terrain?.(x, y) ?? T.grass,
		decorAt: () => 0,
		variantAt: () => 0,
		entityAt: (x, y) =>
			options.player && x === options.player[0] && y === options.player[1]
				? { ch: "@", fg: [127, 255, 106] }
				: undefined,
	};
	return options.elevation ? { ...base, elevationAt: options.elevation } : base;
}

const luminance = (c: Cell) => c.bg[0] + c.bg[1] + c.bg[2];
const at = (rows: Cell[][], x: number, y: number) => rows[y]?.[x] as Cell;

describe("contact shadows", () => {
	// A single wall at (2,2) on otherwise flat grass.
	const walled = sourceFrom({ terrain: (x, y) => (x === 2 && y === 2 ? T.stoneWall : T.grass) });
	const camera = { x: 0, y: 0, width: 6, height: 6 };

	it("darkens the ground east and south of something tall", () => {
		const rows = composeScene(walled, camera, { shadows: true });
		const open = luminance(at(rows, 5, 5));
		expect(luminance(at(rows, 3, 2))).toBeLessThan(open);
		expect(luminance(at(rows, 2, 3))).toBeLessThan(open);
	});

	it("leaves the ground west and north of it alone, because the sun is north-west", () => {
		const rows = composeScene(walled, camera, { shadows: true });
		const open = luminance(at(rows, 5, 5));
		expect(luminance(at(rows, 1, 2))).toBe(open);
		expect(luminance(at(rows, 2, 1))).toBe(open);
	});

	it("casts a softer shadow diagonally than square on, so corners round off", () => {
		const rows = composeScene(walled, camera, { shadows: true });
		const open = luminance(at(rows, 5, 5));
		const diagonal = luminance(at(rows, 3, 3));
		const cardinal = luminance(at(rows, 3, 2));
		expect(diagonal).toBeLessThan(open);
		expect(diagonal).toBeGreaterThan(cardinal);
	});

	it("does not shadow the caster itself, so a wall run stays evenly lit", () => {
		// Two walls side by side: the eastern one must not be darkened by its
		// neighbour, or every wall would fade off to the east.
		const run = sourceFrom({
			terrain: (x, y) => (y === 2 && (x === 2 || x === 3) ? T.stoneWall : T.grass),
		});
		const rows = composeScene(run, camera, { shadows: true });
		const lone = composeScene(walled, camera, { shadows: true });
		expect(luminance(at(rows, 3, 2))).toBe(luminance(at(lone, 2, 2)));
	});

	it("is not cast by tall grass, which blocks sight without being tall", () => {
		// Regression: keying shadows off TFlag.BlocksSight would outline every
		// grass patch, reintroducing the high-frequency noise the generator was
		// changed to remove.
		const grassy = sourceFrom({ terrain: (x, y) => (x === 2 && y === 2 ? T.tallGrass : T.grass) });
		const rows = composeScene(grassy, camera, { shadows: true });
		expect(luminance(at(rows, 3, 2))).toBe(luminance(at(rows, 5, 5)));
	});

	it("is off unless asked for", () => {
		const rows = composeScene(walled, camera, {});
		expect(luminance(at(rows, 3, 2))).toBe(luminance(at(rows, 5, 5)));
	});
});

describe("slope shading", () => {
	const camera = { x: 0, y: 0, width: 8, height: 8 };

	it("brightens ground that faces the sun and darkens ground that faces away", () => {
		// Guards the sign. A heightfield's normal is (-dh/dx, -dh/dy, 1), so ground
		// rising toward the south-east *faces* north-west and catches a north-west
		// sun. Getting this backwards lights every hill from the wrong side, which
		// looks plausible in isolation and wrong next to a shadow.
		const rising = sourceFrom({ elevation: (x, y) => 100 + (x + y) * 6 });
		const falling = sourceFrom({ elevation: (x, y) => 100 - (x + y) * 6 });
		const flat = sourceFrom({ elevation: () => 100 });

		const level = luminance(at(composeScene(flat, camera, { relief: true }), 4, 4));
		expect(luminance(at(composeScene(rising, camera, { relief: true }), 4, 4))).toBeGreaterThan(
			level,
		);
		expect(luminance(at(composeScene(falling, camera, { relief: true }), 4, 4))).toBeLessThan(
			level,
		);
	});

	it("leaves flat ground exactly as authored", () => {
		const flat = sourceFrom({ elevation: () => 100 });
		const shaded = composeScene(flat, camera, { relief: true });
		const plain = composeScene(flat, camera, {});
		expect(at(shaded, 4, 4).bg).toEqual(at(plain, 4, 4).bg);
	});

	it("treats an absent neighbour as level, so the load frontier is not a cliff", () => {
		// elevationAt returns -1 where no chunk is resident. Reading that as
		// height 0 would draw a hard dark seam along the edge of what is loaded --
		// exactly the seam the chunk grid exists to avoid.
		const frontier = sourceFrom({ elevation: (x, _y) => (x >= 4 ? -1 : 100) });
		const rows = composeScene(frontier, camera, { relief: true });
		const flat = composeScene(sourceFrom({ elevation: () => 100 }), camera, { relief: true });
		expect(at(rows, 3, 4).bg).toEqual(at(flat, 3, 4).bg);
	});

	it("is a no-op when the source cannot report elevation", () => {
		const noHeight = sourceFrom({});
		expect(at(composeScene(noHeight, camera, { relief: true }), 4, 4).bg).toEqual(
			at(composeScene(noHeight, camera, {}), 4, 4).bg,
		);
	});

	it("is off unless asked for", () => {
		const rising = sourceFrom({ elevation: (x, y) => 100 + (x + y) * 6 });
		expect(at(composeScene(rising, camera, { relief: true }), 4, 4).bg).not.toEqual(
			at(composeScene(rising, camera, {}), 4, 4).bg,
		);
	});
});

describe("ground lighting and entities", () => {
	const camera = { x: 0, y: 0, width: 8, height: 8 };

	it("never changes how bright the player's own glyph is", () => {
		// The player must read identically on a sunlit slope, in a wall's shadow
		// and on flat ground, or they appear to flicker as they walk.
		const player = [4, 4] as const;
		const lit = sourceFrom({ elevation: (x, y) => 100 + (x + y) * 6, player });
		const shadowed = sourceFrom({
			terrain: (x, y) => (x === 3 && y === 4 ? T.stoneWall : T.grass),
			player,
		});
		const flat = sourceFrom({ elevation: () => 100, player });

		const options = { relief: true, shadows: true };
		const reference = at(composeScene(flat, camera, options), 4, 4);
		expect(reference.ch).toBe("@");
		expect(at(composeScene(lit, camera, options), 4, 4).fg).toEqual(reference.fg);
		expect(at(composeScene(shadowed, camera, options), 4, 4).fg).toEqual(reference.fg);
	});

	it("still shades the ground underneath them", () => {
		// The background keeps the shadow, which is what stops the player from
		// looking like a hole punched through the terrain.
		const player = [4, 4] as const;
		const shadowed = sourceFrom({
			terrain: (x, y) => (x === 3 && y === 4 ? T.stoneWall : T.grass),
			player,
		});
		const rows = composeScene(shadowed, camera, { shadows: true });
		expect(luminance(at(rows, 4, 4))).toBeLessThan(luminance(at(rows, 7, 7)));
	});
});
