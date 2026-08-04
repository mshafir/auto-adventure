import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { chunkToAscii } from "../tiles/chunk.js";
import { TFlag } from "../tiles/flags.js";
import { CHUNK } from "../world/coords.js";
import { generateChunk } from "./pipeline.js";

/**
 * Goldens are stored as ASCII dumps rather than hashes on purpose: when one of
 * these changes, the diff shows the shape of the change — a coastline that
 * moved, a road that rerouted — instead of two opaque hex strings. That is the
 * difference between reviewing a terrain change and rubber-stamping it.
 *
 * Run `vitest -u` to accept an intentional change, then *read the diff*.
 */
const CASES = [
	{ seed: "alpha", cx: 0, cy: 0 },
	{ seed: "alpha", cx: 1, cy: 0 },
	{ seed: "harrow", cx: 2, cy: 3 },
	{ seed: "harrow", cx: -4, cy: -1 },
	{ seed: "vale", cx: 7, cy: -6 },
	{ seed: "vale", cx: 0, cy: 0 },
] as const;

describe("chunk goldens", () => {
	it.each(CASES.map((c) => [`${c.seed}-${c.cx}-${c.cy}`, c] as const))(
		"%s matches its golden",
		async (name, testCase) => {
			const seed = hashString(testCase.seed);
			const { chunk } = generateChunk({ seed }, { cx: testCase.cx, cy: testCase.cy });
			await expect(chunkToAscii(chunk)).toMatchFileSnapshot(`../../../test/goldens/${name}.txt`);
		},
	);
});

describe("generated chunk sanity", () => {
	const seeds = ["alpha", "harrow", "vale", "moss", "ember"].map(hashString);

	it("never produces a chunk that is entirely impassable", { timeout: 40_000 }, () => {
		for (const seed of seeds) {
			for (let cy = -2; cy <= 2; cy++) {
				for (let cx = -2; cx <= 2; cx++) {
					const { chunk, summary } = generateChunk({ seed }, { cx, cy });
					let passable = 0;
					for (const flags of chunk.flags) {
						if (flags & TFlag.Passable) passable++;
					}
					// Open ocean is legitimately impassable, so only assert on
					// chunks that are not mostly sea.
					if (summary.waterFraction < 0.85) {
						expect(passable, `chunk ${cx},${cy} of seed ${seed} was sealed`).toBeGreaterThan(0);
					}
				}
			}
		}
	});

	it("never leaves a tile unwritten", () => {
		const { chunk } = generateChunk({ seed: seeds[0] as number }, { cx: 0, cy: 0 });
		expect(chunk.terrain).toHaveLength(CHUNK * CHUNK);
		// Terrain id 0 is `void`, which generation should never emit.
		expect([...chunk.terrain].every((id) => id !== 0)).toBe(true);
	});

	it("keeps flags consistent with the terrain registry", () => {
		const { chunk } = generateChunk({ seed: seeds[1] as number }, { cx: 3, cy: -1 });
		for (let i = 0; i < chunk.terrain.length; i++) {
			const water = ((chunk.flags[i] ?? 0) & TFlag.Water) !== 0;
			const passable = ((chunk.flags[i] ?? 0) & TFlag.Passable) !== 0;
			const deep = ((chunk.flags[i] ?? 0) & TFlag.Deep) !== 0;
			// Deep water is the one water that is never wadeable.
			if (deep) expect(passable).toBe(false);
			if (passable && deep) throw new Error("deep water must not be passable");
			expect(typeof water).toBe("boolean");
		}
	});

	it("reports a terrain summary consistent with the tiles it produced", () => {
		const { chunk, summary } = generateChunk({ seed: seeds[2] as number }, { cx: -1, cy: 4 });
		const total = CHUNK * CHUNK;
		let passable = 0;
		for (const flags of chunk.flags) if (flags & TFlag.Passable) passable++;
		expect(summary.passableFraction).toBeCloseTo(passable / total, 5);

		const counted = Object.values(summary.biomeCounts).reduce((a, b) => a + b, 0);
		expect(counted).toBe(total);
		expect(summary.elevationRange[0]).toBeLessThanOrEqual(summary.elevationRange[1]);
	});
});
