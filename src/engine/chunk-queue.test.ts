import { describe, expect, it } from "vitest";
import { hashString } from "../core/rand/hash.js";
import type { Command } from "../core/rules/commands.js";
import { createInitialState } from "../core/rules/state.js";
import { type ChunkKey, chunkKey } from "../core/world/coords.js";
import { worldSeed } from "../core/world/recipe.js";
import { ChunkQueue } from "./chunk-queue.js";
import { GameEngine } from "./engine.js";
import { findSpawn } from "./spawn.js";

const SEED = hashString("chunk-queue-test");
const WORLD = {
	id: "chunk-queue",
	name: "Chunk Queue",
	seed: SEED,
	createdAt: "2026-01-01T00:00:00.000Z",
};

/**
 * An engine with nothing running behind it, and a record of what it was told.
 *
 * The queue's whole contract is about *when* work happens, so a test of it has to
 * hold the scheduler itself: `run()` is one turn of the event loop, made explicit.
 */
function harness() {
	const engine = new GameEngine(createInitialState(WORLD, findSpawn(worldSeed(SEED))), {
		// Deliberately inert. The opening prefetch in the constructor is the only
		// building this fixture wants; everything else must come from the queue.
		runEffect: () => undefined,
	});

	const slices: (() => void)[] = [];
	const queue = new ChunkQueue((task) => slices.push(task));

	const commands: Command[] = [];
	const dispatch = engine.dispatch;
	engine.dispatch = (command: Command) => {
		commands.push(command);
		dispatch(command);
	};

	/** One turn of the event loop, or nothing if the queue asked for none. */
	const run = () => {
		const next = slices.shift();
		next?.();
		return next !== undefined;
	};

	return { engine, queue, commands, run, slices };
}

/** Where the player's own chunk is, which is what the ring is centred on. */
function here(engine: GameEngine) {
	const { x, y } = engine.getState().player;
	return { cx: Math.floor(x / 64), cy: Math.floor(y / 64) };
}

function readyKeys(commands: readonly Command[]): ChunkKey[] {
	return commands.flatMap((command) => (command.t === "ChunkReady" ? [...command.keys] : []));
}

describe("asking for a ring", () => {
	it("builds nothing at all before yielding", () => {
		/*
		 * The point of the whole file. A step used to build up to five chunks inside
		 * its own dispatch at ~28ms each, so walking over a chunk seam took the
		 * process away for about 140ms — the lurch, and not the renderer's fault.
		 */
		const { engine, queue } = harness();
		const before = engine.getChunks().residentCount;
		queue.want(engine, here(engine), 3);
		expect(engine.getChunks().residentCount).toBe(before);
		expect(queue.pending).toBeGreaterThan(0);
	});

	it("builds one chunk per slice, so a keystroke never waits on more than one", () => {
		const { engine, queue, run } = harness();
		queue.want(engine, here(engine), 2);
		const start = engine.getChunks().residentCount;
		run();
		expect(engine.getChunks().residentCount).toBe(start + 1);
		run();
		expect(engine.getChunks().residentCount).toBe(start + 2);
	});

	it("keeps asking for slices until the ring is built, then stops", () => {
		const { engine, queue, run } = harness();
		queue.want(engine, here(engine), 2);
		let turns = 0;
		while (run()) {
			turns += 1;
			expect(turns).toBeLessThan(200); // the loop must terminate
		}
		expect(queue.pending).toBe(0);
		// 5x5 around the player, minus the 3x3 the world opened with.
		expect(turns).toBe(25 - 9);
	});

	it("builds the nearest ground first", () => {
		// So that a queue which cannot keep up leaves the *edge* of the map unbuilt
		// rather than a hole in the middle of what the camera is looking at.
		const { engine, queue, run, commands } = harness();
		const centre = here(engine);
		queue.want(engine, centre, 3);
		const distances: number[] = [];
		while (run()) {
			for (const key of readyKeys(commands).slice(distances.length)) {
				const [cx, cy] = key.split(",").map(Number) as [number, number];
				distances.push(Math.max(Math.abs(cx - centre.cx), Math.abs(cy - centre.cy)));
			}
		}
		expect(distances.length).toBeGreaterThan(0);
		expect([...distances].sort((a, b) => a - b)).toEqual(distances);
	});
});

describe("reporting back", () => {
	it("reports a slice as one command rather than one per chunk", () => {
		/*
		 * Every `ChunkReady` that finds new ground is a state change, and every state
		 * change is a full render and a re-uploaded frame. Reporting per chunk meant
		 * crossing a seam cost five renders that differed only in a corner of the
		 * minimap.
		 *
		 * A slice is one chunk by default, so the saving is not visible from the
		 * queue's own output — what is asserted here is the shape that makes it
		 * possible: one command per slice, whatever the slice turns out to hold. The
		 * reducer's half of the bargain is pinned in `reduce.test.ts`.
		 */
		const { engine, queue, run, commands } = harness();
		queue.want(engine, here(engine), 2);
		let slices = 0;
		while (run()) slices += 1;
		const ready = commands.filter((command) => command.t === "ChunkReady");
		// One per slice that built something — never one per chunk, and never one per
		// slice that found the ground already there.
		expect(ready.length).toBeLessThanOrEqual(slices);
		expect(ready.length).toBe(readyKeys(commands).length);
	});

	it("marks what it built as discovered", () => {
		const { engine, queue, run } = harness();
		const centre = here(engine);
		queue.want(engine, centre, 2);
		while (run());
		const seen = new Set(engine.getState().discovered);
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				expect(seen.has(chunkKey(centre.cx + dx, centre.cy + dy)), `${dx},${dy}`).toBe(true);
			}
		}
	});

	it("says nothing when the ring was already built", () => {
		const { engine, queue, run, commands } = harness();
		queue.want(engine, here(engine), 1);
		while (run());
		commands.length = 0;
		queue.want(engine, here(engine), 1);
		while (run());
		expect(commands).toEqual([]);
	});
});

describe("a queue that the player walks out from under", () => {
	it("re-aims at the new centre rather than finishing the old ring", () => {
		/*
		 * `want` arrives on every step, and by the time the far corner of a ring comes
		 * up the player may be nowhere near it. Appending would have the queue working
		 * through ground the camera left behind while the ground ahead went unbuilt.
		 */
		const { engine, queue, run, commands } = harness();
		const centre = here(engine);
		queue.want(engine, centre, 2);
		const far = { cx: centre.cx + 20, cy: centre.cy + 20 };
		queue.want(engine, far, 1);

		while (run());
		const built = readyKeys(commands);
		expect(built).toContain(chunkKey(far.cx, far.cy));
		// Nothing from the abandoned ring, except where the two happen to overlap —
		// and twenty chunks apart, they do not.
		for (const key of built) {
			const [cx, cy] = key.split(",").map(Number) as [number, number];
			expect(Math.max(Math.abs(cx - far.cx), Math.abs(cy - far.cy))).toBeLessThanOrEqual(1);
		}
	});

	it("does not stack up a scheduled slice per step", () => {
		// Held keys dispatch `want` far faster than a chunk takes to build. One
		// outstanding slice at a time is what keeps that from becoming a queue of
		// callbacks each of which rebuilds the same ring.
		const { engine, queue, slices } = harness();
		for (let step = 0; step < 20; step++) queue.want(engine, here(engine), 2);
		expect(slices.length).toBe(1);
	});
});
