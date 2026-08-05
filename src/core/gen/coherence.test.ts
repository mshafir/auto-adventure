import { describe, expect, it } from "vitest";
import { worldSeed } from "../../core/world/recipe.js";
import { hashString } from "../rand/hash.js";
import { CHUNK } from "../world/coords.js";
import { generateChunk } from "./pipeline.js";

/**
 * Terrain has to form regions, not static.
 *
 * The alternate ground used to be chosen per tile by `valueAt`, which is a hash
 * — white noise. A quarter of every biome's tiles flipped independently of their
 * neighbours, so grassland rendered as grass with gravel *dust* rather than grass
 * with gravel patches. It measured 38% disagreement between horizontally adjacent
 * tiles; the map read as visual noise and, because almost every cell changed
 * colour from the one before it, the row encoder had nothing to collapse and
 * frames ran to 45KB.
 *
 * These bounds are deliberately loose. The point is not to pin an exact number
 * but to fail loudly if a future change goes back to sampling a hash where it
 * meant to sample a field.
 */

const SEEDS = ["default", "vale", "alpha", "harrow"] as const;
const CHUNKS = [
	[0, 0],
	[-3, 1],
	[2, 4],
	[7, -6],
] as const;

/** Fraction of horizontally adjacent tile pairs that are different terrain. */
function disagreement(seed: number, cx: number, cy: number): number {
	const { chunk } = generateChunk({ world: worldSeed(seed) }, { cx, cy });
	let differing = 0;
	let pairs = 0;
	for (let y = 0; y < CHUNK; y++) {
		for (let x = 1; x < CHUNK; x++) {
			if (chunk.terrain[y * CHUNK + x] !== chunk.terrain[y * CHUNK + x - 1]) differing++;
			pairs++;
		}
	}
	return differing / pairs;
}

describe("terrain coherence", () => {
	it("keeps neighbouring tiles mostly in agreement across seeds and chunks", () => {
		const samples: number[] = [];
		for (const name of SEEDS) {
			const seed = hashString(name);
			for (const [cx, cy] of CHUNKS) samples.push(disagreement(seed, cx, cy));
		}

		const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
		// White noise alt-ground measured ~0.38 here. Genuine biome borders and
		// individually-scattered trees account for the rest, and those *should*
		// differ from their neighbours.
		expect(mean).toBeLessThan(0.25);
		// No single chunk may be pure static either, or one biome could regress
		// while the average stayed respectable.
		expect(Math.max(...samples)).toBeLessThan(0.35);
		// Generating sixteen cold chunks, several of them settlements, runs past
		// the default timeout when the suites are sharing cores.
	}, 60_000);

	it("still varies the ground rather than flattening it to one terrain", () => {
		// The cheap way to pass the test above is to stop varying ground at all.
		const seed = hashString("default");
		const kinds = new Set<number>();
		for (const [cx, cy] of CHUNKS) {
			const { chunk } = generateChunk({ world: worldSeed(seed) }, { cx, cy });
			for (const id of chunk.terrain) kinds.add(id);
		}
		expect(kinds.size).toBeGreaterThan(8);
	}, 30_000);

	it("records elevation so the renderer can shade by slope without resampling", () => {
		const { chunk } = generateChunk({ world: worldSeed(hashString("vale")) }, { cx: 0, cy: 0 });
		const heights = new Set(chunk.elevation);
		expect(heights.size).toBeGreaterThan(4);
		// Quantised into a Uint8Array, so this is total by construction; the check
		// is that it was actually written rather than left at zero.
		expect(Math.max(...chunk.elevation)).toBeGreaterThan(0);
	});
});
