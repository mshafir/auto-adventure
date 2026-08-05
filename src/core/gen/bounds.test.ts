import { describe, expect, it } from "vitest";
import { worldSeed } from "../../core/world/recipe.js";
import { hashString } from "../rand/hash.js";
import { TFlag } from "../tiles/flags.js";
import { terrainDef } from "../tiles/terrain.js";
import {
	type BoundaryStyle,
	boundaryTerrain,
	boundsAround,
	isBoundary,
	isWellInside,
	safeInterior,
	type WorldBounds,
} from "../world/bounds.js";
import { CHUNK, type ChunkCoord, localIndex } from "../world/coords.js";
import { generateChunk } from "./pipeline.js";

const SEED = hashString("bounds-test");

/** A bound a few chunks across, centred on the origin. */
const BOUNDS: WorldBounds = {
	minX: -100,
	minY: -100,
	maxX: 100,
	maxY: 100,
	style: "mountains",
	thickness: 8,
};

function chunkOf(cc: ChunkCoord, bounds?: WorldBounds) {
	return generateChunk({ world: worldSeed(SEED), ...(bounds ? { bounds } : {}) }, cc);
}

describe("isBoundary", () => {
	it("is true everywhere outside the rectangle", () => {
		for (const [x, y] of [
			[-101, 0],
			[101, 0],
			[0, -101],
			[0, 101],
			[-5000, -5000],
			[5000, 5000],
		] as const) {
			expect(isBoundary(SEED, BOUNDS, x, y)).toBe(true);
		}
	});

	it("is false well inside the rectangle", () => {
		for (const [x, y] of [
			[0, 0],
			[50, 50],
			[-50, -50],
			[-91, 0],
		] as const) {
			expect(isBoundary(SEED, BOUNDS, x, y)).toBe(false);
		}
	});

	it("closes the ring with no gaps", () => {
		// The band cannot develop a hole: outside the rectangle the edge distance is
		// negative and the intrusion is never negative, so this holds by
		// construction rather than by luck. Walk the whole perimeter to prove it.
		for (let x = BOUNDS.minX - 1; x <= BOUNDS.maxX + 1; x++) {
			expect(isBoundary(SEED, BOUNDS, x, BOUNDS.minY - 1)).toBe(true);
			expect(isBoundary(SEED, BOUNDS, x, BOUNDS.maxY + 1)).toBe(true);
		}
		for (let y = BOUNDS.minY - 1; y <= BOUNDS.maxY + 1; y++) {
			expect(isBoundary(SEED, BOUNDS, BOUNDS.minX - 1, y)).toBe(true);
			expect(isBoundary(SEED, BOUNDS, BOUNDS.maxX + 1, y)).toBe(true);
		}
	});

	it("wanders rather than tracing the rectangle", () => {
		// A perfectly straight inner edge reads as a drawn box. Sample the band's
		// depth along one side and check it is not constant.
		const depths = new Set<number>();
		for (let x = BOUNDS.minX; x <= BOUNDS.maxX; x += 3) {
			let depth = 0;
			while (depth < BOUNDS.thickness && isBoundary(SEED, BOUNDS, x, BOUNDS.minY + depth)) depth++;
			depths.add(depth);
		}
		expect(depths.size).toBeGreaterThan(1);
	});

	it("is a pure function of seed, bounds and position", () => {
		expect(isBoundary(SEED, BOUNDS, 7, -93)).toBe(isBoundary(SEED, BOUNDS, 7, -93));
		// A different seed must move the wobble, or the edge would look identical in
		// every scenario built on the same rectangle.
		const other = hashString("bounds-test-other");
		let differs = false;
		for (let x = BOUNDS.minX; x <= BOUNDS.maxX && !differs; x++) {
			for (let d = 0; d < BOUNDS.thickness; d++) {
				if (
					isBoundary(SEED, BOUNDS, x, BOUNDS.minY + d) !==
					isBoundary(other, BOUNDS, x, BOUNDS.minY + d)
				) {
					differs = true;
					break;
				}
			}
		}
		expect(differs).toBe(true);
	});
});

describe("isWellInside", () => {
	it("excludes everything the wobble could reach", () => {
		// Whatever the noise does, a position this function accepts is playable.
		for (let x = BOUNDS.minX; x <= BOUNDS.maxX; x += 7) {
			for (let y = BOUNDS.minY; y <= BOUNDS.maxY; y += 7) {
				if (isWellInside(BOUNDS, x, y)) expect(isBoundary(SEED, BOUNDS, x, y)).toBe(false);
			}
		}
	});

	it("agrees with safeInterior", () => {
		const safe = safeInterior(BOUNDS);
		expect(isWellInside(BOUNDS, safe.minX, safe.minY)).toBe(true);
		expect(isWellInside(BOUNDS, safe.maxX, safe.maxY)).toBe(true);
		expect(isWellInside(BOUNDS, safe.minX - 1, safe.minY)).toBe(false);
	});
});

describe("boundaryTerrain", () => {
	it("is impassable for every style", () => {
		// A passable edge is a way out. Shallow water is the trap here — it carries
		// Passable, which is why "ocean" has to mean deep water — and the check is
		// against the terrain registry so adding a style cannot quietly open a hole.
		for (const style of ["ocean", "cliffs", "mountains"] as BoundaryStyle[]) {
			const flags = terrainDef(boundaryTerrain(style)).flags;
			expect(flags & TFlag.Passable).toBe(0);
		}
	});

	it("is never the void sentinel", () => {
		// Terrain 0 means "nothing generated here". An edge made of it would be
		// indistinguishable from a chunk that failed to build.
		for (const style of ["ocean", "cliffs", "mountains"] as BoundaryStyle[]) {
			expect(boundaryTerrain(style)).toBeGreaterThan(0);
		}
	});
});

describe("the S9 boundary stage", () => {
	it("leaves an unbounded chunk byte-identical", () => {
		// The whole reason the goldens do not move: no caller passes bounds today.
		const plain = chunkOf({ cx: 0, cy: 0 }).chunk;
		const again = chunkOf({ cx: 0, cy: 0 }).chunk;
		expect(Array.from(again.terrain)).toEqual(Array.from(plain.terrain));
		expect(Array.from(again.flags)).toEqual(Array.from(plain.flags));
	});

	it("makes every tile outside the rectangle impassable", () => {
		// A chunk straddling the eastern edge: x from 64 to 127, edge at 100.
		const cc = { cx: 1, cy: 0 };
		const { chunk } = chunkOf(cc, BOUNDS);
		for (let ly = 0; ly < CHUNK; ly++) {
			for (let lx = 0; lx < CHUNK; lx++) {
				const wx = cc.cx * CHUNK + lx;
				const wy = cc.cy * CHUNK + ly;
				if (!isBoundary(SEED, BOUNDS, wx, wy)) continue;
				const flags = chunk.flags[localIndex(lx, ly)] ?? 0;
				expect(flags & TFlag.Passable).toBe(0);
			}
		}
	});

	it("clears decor under the band", () => {
		const cc = { cx: 1, cy: 0 };
		const { chunk } = chunkOf(cc, BOUNDS);
		for (let ly = 0; ly < CHUNK; ly++) {
			for (let lx = 0; lx < CHUNK; lx++) {
				const wx = cc.cx * CHUNK + lx;
				const wy = cc.cy * CHUNK + ly;
				if (!isBoundary(SEED, BOUNDS, wx, wy)) continue;
				expect(chunk.decor[localIndex(lx, ly)]).toBe(0);
			}
		}
	});

	it("leaves a chunk entirely inside the rectangle untouched", () => {
		// Bounds must not reach into the interior at all, or every scenario would
		// generate different terrain from the unbounded world it was surveyed from.
		const plain = chunkOf({ cx: 0, cy: 0 }).chunk;
		const bounded = chunkOf({ cx: 0, cy: 0 }, BOUNDS).chunk;
		expect(Array.from(bounded.terrain)).toEqual(Array.from(plain.terrain));
		expect(Array.from(bounded.flags)).toEqual(Array.from(plain.flags));
	});

	it("stamps a chunk wholly outside the rectangle as solid boundary", () => {
		const { chunk, summary } = chunkOf({ cx: 4, cy: 4 }, BOUNDS);
		expect(summary.passableFraction).toBe(0);
		const expected = boundaryTerrain(BOUNDS.style);
		for (const id of chunk.terrain) expect(id).toBe(expected);
	});

	it("reports the boundary in the terrain summary", () => {
		// The summary is what the director is shown, so it has to describe the
		// chunk as it ended up rather than as the wilderness stages left it.
		const open = chunkOf({ cx: 1, cy: 0 }).summary;
		const bounded = chunkOf({ cx: 1, cy: 0 }, BOUNDS).summary;
		expect(bounded.passableFraction).toBeLessThan(open.passableFraction);
	});

	it("generates a bounded block identically under shuffled order", () => {
		// The seam contract still holds: bounds is a constant, not a neighbour read.
		const coords: ChunkCoord[] = [];
		for (let cy = -1; cy <= 2; cy++) for (let cx = -1; cx <= 2; cx++) coords.push({ cx, cy });

		const digest = (cc: ChunkCoord) => Array.from(chunkOf(cc, BOUNDS).chunk.terrain).join(",");
		const forward = new Map(coords.map((cc) => [`${cc.cx},${cc.cy}`, digest(cc)]));
		for (const cc of [...coords].reverse()) {
			expect(digest(cc)).toBe(forward.get(`${cc.cx},${cc.cy}`));
		}
	});
});

describe("a bounded world is inescapable", () => {
	it("cannot be walked out of from anywhere inside it", () => {
		// The guarantee the whole feature rests on. Flood from the spawn across a
		// block of chunks wider than the bound and check nothing reachable lies
		// outside the rectangle — not that the band looks closed, but that no walk
		// exists through it.
		const bounds: WorldBounds = {
			minX: -80,
			minY: -80,
			maxX: 80,
			maxY: 80,
			style: "cliffs",
			thickness: 6,
		};
		// Chunks -3..3 span x,y in [-192, 255], comfortably past the edge at ±80.
		const passable = new Set<string>();
		for (let cy = -3; cy <= 3; cy++) {
			for (let cx = -3; cx <= 3; cx++) {
				const { chunk } = chunkOf({ cx, cy }, bounds);
				for (let ly = 0; ly < CHUNK; ly++) {
					for (let lx = 0; lx < CHUNK; lx++) {
						const flags = chunk.flags[localIndex(lx, ly)] ?? 0;
						if (flags & TFlag.Passable) passable.add(`${cx * CHUNK + lx},${cy * CHUNK + ly}`);
					}
				}
			}
		}

		// Start from a passable tile well inside the bound. Found here rather than
		// via `findSpawn` so a core test does not reach up into the engine.
		const start = [...passable]
			.map((key) => {
				const [x, y] = key.split(",").map(Number) as [number, number];
				return { x, y };
			})
			.find((at) => isWellInside(bounds, at.x, at.y));
		if (!start) throw new Error("no passable tile inside the bound");

		const seen = new Set<string>([`${start.x},${start.y}`]);
		const queue = [start];
		while (queue.length > 0) {
			const at = queue.pop() as { x: number; y: number };
			// Anything reached must be inside the rectangle, or the band leaked.
			expect(isBoundary(SEED, bounds, at.x, at.y)).toBe(false);
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			] as const) {
				const nx = at.x + dx;
				const ny = at.y + dy;
				const key = `${nx},${ny}`;
				if (seen.has(key) || !passable.has(key)) continue;
				seen.add(key);
				queue.push({ x: nx, y: ny });
			}
		}

		// And the reachable area is a real world, not a pocket the spawn fell into.
		expect(seen.size).toBeGreaterThan(1000);
	});
});

describe("boundsAround", () => {
	it("centres a square bound on a position", () => {
		const bounds = boundsAround({ x: 10, y: -20 }, 50, { style: "ocean", thickness: 4 });
		expect(bounds).toEqual({
			minX: -40,
			minY: -70,
			maxX: 60,
			maxY: 30,
			style: "ocean",
			thickness: 4,
		});
	});
});
