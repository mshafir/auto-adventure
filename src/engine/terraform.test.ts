import { describe, expect, it } from "vitest";
import { hashString } from "../core/rand/hash.js";
import { TFlag } from "../core/tiles/flags.js";
import { T } from "../core/tiles/terrain.js";
import { CHUNK, chunkKey } from "../core/world/coords.js";
import { worldSeed } from "../core/world/recipe.js";
import type { TerraformEdit } from "../scenario/terraform.js";
import { ChunkManager } from "./chunk-manager.js";
import { createWorldView } from "./world-view.js";

const SEED = hashString("terraform-test");

/** A lane across the first chunk, laid where the generator put whatever it put. */
const LANE: TerraformEdit = {
	t: "Path",
	id: "the-lane",
	from: { x: 4, y: 8 },
	to: { x: 20, y: 8 },
	surface: "cobble",
};

function manager(terraform: readonly TerraformEdit[]) {
	const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 16, terraform });
	chunks.prefetch({ cx: 0, cy: 0 }, 1);
	return chunks;
}

/** The view addresses world coordinates; the manager is only its chunk source. */
function viewOf(chunks: ChunkManager) {
	return createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });
}

describe("authored ground in a generated world", () => {
	it("lays the tiles the scenario asked for", () => {
		const view = viewOf(manager([LANE]));
		for (let x = 4; x <= 20; x++) {
			expect(view.terrainAt(x, 8), `${x},8`).toBe(T.cobbleRoad);
		}
	});

	it("makes them walkable, whatever was there before", () => {
		// The point of a path: it goes through the trees rather than round them. Flags come from
		// the terrain definition, so a road is passable for the same reason every road is.
		const view = viewOf(manager([LANE]));
		for (let x = 4; x <= 20; x++) {
			expect(view.isPassable(x, 8), `${x},8`).toBe(true);
		}
	});

	it("clears the decor it lays over, so nothing grows through the road", () => {
		const view = viewOf(manager([LANE]));
		for (let x = 4; x <= 20; x++) {
			expect(view.decorAt(x, 8), `${x},8`).toBe(0);
		}
	});

	it("leaves the ground beside it exactly as the generator made it", () => {
		const plain = viewOf(manager([]));
		const paved = viewOf(manager([LANE]));
		let compared = 0;
		for (let x = 4; x <= 20; x++) {
			for (const y of [5, 11]) {
				expect(paved.terrainAt(x, y), `${x},${y}`).toBe(plain.terrainAt(x, y));
				compared++;
			}
		}
		expect(compared).toBeGreaterThan(0);
	});

	it("crosses a chunk boundary without a seam", () => {
		const across: TerraformEdit = {
			t: "Path",
			id: "the-long-lane",
			from: { x: CHUNK - 4, y: 20 },
			to: { x: CHUNK + 4, y: 20 },
			surface: "dirt",
		};
		const view = viewOf(manager([across]));
		for (let x = CHUNK - 4; x <= CHUNK + 4; x++) {
			expect(view.terrainAt(x, 20), `${x},20`).toBe(T.dirtRoad);
		}
	});

	it("survives the chunk being evicted and rebuilt", () => {
		// Eviction is safe because generation is deterministic, and authored ground has to be
		// part of that determinism rather than a patch applied once — otherwise a road would
		// vanish from a world the player had merely walked away from and come back to.
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 1, terraform: [LANE] });
		chunks.ensure(0, 0);
		expect(viewOf(chunks).terrainAt(8, 8)).toBe(T.cobbleRoad);

		// One chunk of capacity, so building any other evicts this one.
		chunks.ensure(40, 40);
		expect(chunks.has(0, 0)).toBe(false);

		chunks.ensure(0, 0);
		expect(viewOf(chunks).terrainAt(8, 8)).toBe(T.cobbleRoad);
	});
});

describe("setTerraform", () => {
	/*
	 * A fresh view after each rebuild, deliberately. `createWorldView` memoises the last chunk
	 * it resolved, so one built before an invalidation hands back the stale object until it is
	 * asked about a different chunk. That predates this — `invalidateRect` has always had it —
	 * and self-corrects within a render pass, because a viewport spans several chunks. What is
	 * under test here is the manager, so the view must not be the thing being measured.
	 */
	it("drops the chunks the new ground touches, so it gets stamped", () => {
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 16 });
		chunks.prefetch({ cx: 0, cy: 0 }, 0);
		const before = viewOf(chunks).terrainAt(8, 8);

		expect(chunks.setTerraform([LANE])).toContain(chunkKey(0, 0));

		chunks.ensure(0, 0);
		expect(viewOf(chunks).terrainAt(8, 8)).toBe(T.cobbleRoad);
		expect(before).not.toBe(T.cobbleRoad);
	});

	it("drops the chunks the *old* ground touched, so a removed edit is un-laid", () => {
		// A stamped tile cannot be un-stamped from a resident chunk, so the union of the old and
		// new rectangles has to go. Without this, taking a road out of a later phase would leave
		// the road on screen until the chunk happened to be evicted for some other reason.
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 16, terraform: [LANE] });
		chunks.prefetch({ cx: 0, cy: 0 }, 0);
		expect(viewOf(chunks).terrainAt(8, 8)).toBe(T.cobbleRoad);

		expect(chunks.setTerraform([])).toContain(chunkKey(0, 0));
		chunks.ensure(0, 0);
		expect(viewOf(chunks).terrainAt(8, 8)).not.toBe(T.cobbleRoad);
	});

	it("drops nothing when the edits have not changed", () => {
		const edits = [LANE];
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 16, terraform: edits });
		chunks.prefetch({ cx: 0, cy: 0 }, 0);
		expect(chunks.setTerraform(edits)).toEqual([]);
		expect(chunks.residentCount).toBe(1);
	});

	it("leaves a chunk nowhere near the change resident", () => {
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 32 });
		chunks.prefetch({ cx: 0, cy: 0 }, 1);
		const far = chunkKey(1, 1);
		expect(chunks.setTerraform([LANE])).not.toContain(far);
		expect(chunks.has(1, 1)).toBe(true);
	});

	it("does not mistake an unwalkable tile for a passable one afterwards", () => {
		// The flags travel with the terrain, so a chunk rebuilt without the road is impassable
		// again wherever the generator had put trees.
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 16, terraform: [LANE] });
		chunks.prefetch({ cx: 0, cy: 0 }, 0);
		expect(viewOf(chunks).flagsAt(8, 8) & TFlag.Passable).not.toBe(0);
	});
});
