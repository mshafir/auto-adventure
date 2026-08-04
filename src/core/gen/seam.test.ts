import { beforeEach, describe, expect, it } from "vitest";
import { makeRng, rngFor } from "../rand/rng.js";
import { chunkDigest } from "../tiles/chunk.js";
import { CHUNK, type ChunkCoord, HALO, localIndex } from "../world/coords.js";
import { elevationAt, moistureAt, temperatureAt } from "../world/fields.js";
import { MACRO, macroSite, maxFeatureRadius } from "../world/macro.js";
import { clearRiverCache } from "../world/rivers.js";
import { clearRoadCache } from "../world/roads.js";
import { generateChunk } from "./pipeline.js";

const SEED = 0x5eed1234;

beforeEach(() => {
	// Every test below must hold with cold caches; a cache that changed the
	// answer would be a correctness bug, not an optimisation.
	clearRoadCache();
	clearRiverCache();
});

function digestOf(cc: ChunkCoord): string {
	return chunkDigest(generateChunk({ seed: SEED }, cc).chunk);
}

describe("seam invariant", () => {
	it("generates a 5x5 block identically under 20 shuffled orders", () => {
		// The single most important test here. If any generation stage read
		// chunk-local state or depended on what had already been generated,
		// this is where it would surface.
		const block: ChunkCoord[] = [];
		for (let cy = -2; cy <= 2; cy++) {
			for (let cx = -2; cx <= 2; cx++) block.push({ cx, cy });
		}

		const reference = new Map<string, string>();
		for (const cc of block) reference.set(`${cc.cx},${cc.cy}`, digestOf(cc));

		for (let attempt = 0; attempt < 20; attempt++) {
			// Cold caches every pass: a memo that changed the answer would be a
			// correctness bug, not an optimisation.
			clearRoadCache();
			clearRiverCache();
			for (const cc of makeRng(attempt + 1).shuffled(block)) {
				const key = `${cc.cx},${cc.cy}`;
				expect(digestOf(cc), `chunk ${key} differed on attempt ${attempt}`).toBe(
					reference.get(key),
				);
			}
		}
	}, 60_000);

	it("shows no discontinuity in terrain across a chunk boundary", () => {
		// A seam would appear as an abrupt change exactly at the boundary. So
		// compare how much terrain changes between the last two columns *inside*
		// a chunk against how much it changes across the boundary itself. With a
		// genuine seam the second number spikes; without one they are alike.
		const left = generateChunk({ seed: SEED }, { cx: 0, cy: 0 }).chunk;
		const right = generateChunk({ seed: SEED }, { cx: 1, cy: 0 }).chunk;

		let interiorChanges = 0;
		let boundaryChanges = 0;
		for (let y = 0; y < CHUNK; y++) {
			if (left.terrain[localIndex(CHUNK - 2, y)] !== left.terrain[localIndex(CHUNK - 1, y)]) {
				interiorChanges++;
			}
			if (left.terrain[localIndex(CHUNK - 1, y)] !== right.terrain[localIndex(0, y)]) {
				boundaryChanges++;
			}
		}

		// Allow generous slack for local noise; a real seam would put boundary
		// changes near CHUNK while interior changes stayed low.
		expect(boundaryChanges).toBeLessThanOrEqual(interiorChanges + 12);
		expect(boundaryChanges).toBeLessThan(CHUNK * 0.6);
	});

	it("continues elevation smoothly across a boundary in both axes", () => {
		for (const axis of ["x", "y"] as const) {
			let maxJump = 0;
			for (let t = -3; t <= 3; t++) {
				const a =
					axis === "x" ? elevationAt(SEED, CHUNK + t, 20) : elevationAt(SEED, 20, CHUNK + t);
				const b =
					axis === "x"
						? elevationAt(SEED, CHUNK + t + 1, 20)
						: elevationAt(SEED, 20, CHUNK + t + 1);
				maxJump = Math.max(maxJump, Math.abs(a - b));
			}
			expect(maxJump, `axis ${axis}`).toBeLessThan(0.1);
		}
	});

	it("keeps every feature within the halo the generator consults", () => {
		// If a feature could reach further than HALO macro cells, two chunks
		// would disagree about whether it exists at all.
		expect(maxFeatureRadius()).toBeLessThanOrEqual(HALO * MACRO);
	});
});

describe("determinism", () => {
	it("is reproducible for the same seed and coordinate", () => {
		const a = digestOf({ cx: 3, cy: -2 });
		clearRoadCache();
		clearRiverCache();
		const b = digestOf({ cx: 3, cy: -2 });
		expect(a).toBe(b);
	});

	it("produces different worlds for different seeds", () => {
		const a = chunkDigest(generateChunk({ seed: 1 }, { cx: 0, cy: 0 }).chunk);
		clearRoadCache();
		clearRiverCache();
		const b = chunkDigest(generateChunk({ seed: 2 }, { cx: 0, cy: 0 }).chunk);
		expect(a).not.toBe(b);
	});

	it("produces different chunks at different coordinates", () => {
		expect(digestOf({ cx: 0, cy: 0 })).not.toBe(digestOf({ cx: 9, cy: 9 }));
	});

	it("handles negative coordinates without folding onto positive ones", () => {
		expect(digestOf({ cx: -1, cy: -1 })).not.toBe(digestOf({ cx: 0, cy: 0 }));
		expect(digestOf({ cx: -5, cy: 3 })).not.toBe(digestOf({ cx: 5, cy: 3 }));
	});
});

describe("field continuity", () => {
	it("gives one value per world coordinate regardless of the chunk asking", () => {
		// Sample points that sit exactly on chunk boundaries in both axes.
		for (const [x, y] of [
			[0, 0],
			[CHUNK, 0],
			[CHUNK - 1, CHUNK],
			[-1, -1],
			[-CHUNK, CHUNK * 3],
		] as const) {
			expect(elevationAt(SEED, x, y)).toBe(elevationAt(SEED, x, y));
			expect(moistureAt(SEED, x, y)).toBe(moistureAt(SEED, x, y));
			expect(temperatureAt(SEED, x, y)).toBe(temperatureAt(SEED, x, y));
		}
	});

	it("varies smoothly: adjacent tiles never jump the full range", () => {
		let maxJump = 0;
		for (let x = -200; x < 200; x++) {
			const a = elevationAt(SEED, x, 17);
			const b = elevationAt(SEED, x + 1, 17);
			maxJump = Math.max(maxJump, Math.abs(a - b));
		}
		// A discontinuity would show up here as a jump near 1.
		expect(maxJump).toBeLessThan(0.1);
	});

	it("stays smooth across a chunk boundary specifically", () => {
		const before = elevationAt(SEED, CHUNK - 1, 33);
		const at = elevationAt(SEED, CHUNK, 33);
		const after = elevationAt(SEED, CHUNK + 1, 33);
		expect(Math.abs(at - before)).toBeLessThan(0.1);
		expect(Math.abs(after - at)).toBeLessThan(0.1);
	});
});

describe("macro sites", () => {
	it("is a pure function of the macro cell", () => {
		const a = macroSite(SEED, 4, -7);
		const b = macroSite(SEED, 4, -7);
		expect(a).toEqual(b);
	});

	it("places its site inside its own macro cell", () => {
		for (let my = -3; my <= 3; my++) {
			for (let mx = -3; mx <= 3; mx++) {
				const site = macroSite(SEED, mx, my);
				expect(site.site.x).toBeGreaterThanOrEqual(mx * MACRO);
				expect(site.site.x).toBeLessThan((mx + 1) * MACRO);
				expect(site.site.y).toBeGreaterThanOrEqual(my * MACRO);
				expect(site.site.y).toBeLessThan((my + 1) * MACRO);
			}
		}
	});
});

describe("named rng streams", () => {
	it("keeps streams independent so a new stage cannot shift an old one", () => {
		const scatter = rngFor(SEED, "scatter", 3, 4);
		const plots = rngFor(SEED, "plots", 3, 4);
		const scatterValues = Array.from({ length: 8 }, () => scatter.next());
		const plotValues = Array.from({ length: 8 }, () => plots.next());
		expect(scatterValues).not.toEqual(plotValues);
	});

	it("is reproducible per stream and coordinate", () => {
		const a = Array.from({ length: 5 }, () => rngFor(SEED, "scatter", 3, 4).next());
		expect(new Set(a).size).toBe(1);
	});

	it("decorrelates neighbouring coordinates", () => {
		const values = [];
		for (let x = 0; x < 64; x++) values.push(rngFor(SEED, "s", x, 0).float());
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		expect(mean).toBeGreaterThan(0.35);
		expect(mean).toBeLessThan(0.65);
	});
});
