import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import { createInitialState, type GameState, type Quest } from "../../core/rules/state.js";
import { CHUNK, chunkKey } from "../../core/world/coords.js";
import { isSettlement, macroSite } from "../../core/world/macro.js";
import { worldSeed } from "../../core/world/recipe.js";
import { ChunkQueue } from "../../engine/chunk-queue.js";
import { GameEngine } from "../../engine/engine.js";
import { findSpawn } from "../../engine/spawn.js";
import { checkGlyph } from "./glyph-safety.js";
import { minimapCells, minimapGlyphs } from "./minimap-data.js";

const SEED = hashString("vale");
const WORLD = { id: "t", name: "T", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" };

/** A settled chunk in this seed, so the test marks somewhere that exists. */
function findSettlement(): { cx: number; cy: number; siteId: number } {
	for (let cx = -6; cx <= 6; cx++) {
		for (let cy = -6; cy <= 6; cy++) {
			const site = macroSite(worldSeed(SEED), cx, cy);
			if (isSettlement(site.kind)) return { cx, cy, siteId: site.id };
		}
	}
	throw new Error("no settlement in range");
}

const TOWN = findSettlement();

function stateAt(cx: number, cy: number, overrides: Partial<GameState> = {}): GameState {
	return {
		...createInitialState(WORLD, { x: cx * CHUNK + 1, y: cy * CHUNK + 1 }),
		...overrides,
	};
}

/** Every chunk within `radius` of the player's, so nothing is blank by accident. */
function allSeen(cx: number, cy: number, radius: number): string[] {
	const keys: string[] = [];
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) keys.push(chunkKey(cx + dx, cy + dy));
	}
	return keys;
}

describe("minimapCells", () => {
	it("puts the player at the centre", () => {
		const rows = minimapCells(stateAt(3, -2), 11, 7);
		expect(rows).toHaveLength(7);
		expect(rows[0]).toHaveLength(11);
		expect(rows[3]?.[5]?.ch).toBe("@");
	});

	it("keeps them at the centre after they walk into a building", () => {
		// Indoors the player's coordinates are local to the interior grid, so centring on
		// them put the map over a chunk near the world origin — a stretch of empty fen
		// nobody had ever walked into, drawn as though it were where you were standing.
		// The map is at its most useful when you are lost, and going indoors is exactly
		// when a player gets lost.
		// Discovered ground around them, or every cell is blank and two wrong answers
		// compare equal.
		const outdoors = stateAt(3, -2, { discovered: allSeen(3, -2, 4) });
		const inside: GameState = {
			...outdoors,
			player: {
				...outdoors.player,
				x: 5,
				y: 7,
				inside: {
					interiorId: 42,
					structure: "house",
					returnX: outdoors.player.x,
					returnY: outdoors.player.y,
				},
			},
		};
		expect(minimapCells(inside, 11, 7)).toEqual(minimapCells(outdoors, 11, 7));
	});

	// Odd in both directions is what centres the player; the alternative is
	// drawing them half a cell off, which reads as the map being wrong.
	it("stays odd-sized and never exceeds the space it was given", () => {
		for (const [w, h] of [
			[10, 6],
			[11, 7],
			[1, 1],
			[2, 2],
		] as const) {
			const rows = minimapCells(stateAt(0, 0), w, h);
			expect(rows.length, `${w}x${h}`).toBeLessThanOrEqual(h);
			expect(rows.length % 2, `${w}x${h}`).toBe(1);
			expect((rows[0] as unknown[]).length, `${w}x${h}`).toBeLessThanOrEqual(w);
			expect((rows[0] as unknown[]).length % 2, `${w}x${h}`).toBe(1);
		}
	});

	it("draws only chunks the player has walked into", () => {
		const blank = minimapCells(stateAt(0, 0), 9, 5);
		// The player's own chunk is always drawn; everything else is unvisited.
		const drawn = blank.flat().filter((cell) => cell.ch !== " ");
		expect(drawn.map((cell) => cell.ch)).toEqual(["@"]);

		const seen = minimapCells(stateAt(0, 0, { discovered: allSeen(0, 0, 4) }), 9, 5);
		expect(seen.flat().every((cell) => cell.ch !== " ")).toBe(true);
	});

	it("marks a settlement the player has found", () => {
		const rows = minimapCells(
			stateAt(TOWN.cx, TOWN.cy, { discovered: [chunkKey(TOWN.cx, TOWN.cy)] }),
			9,
			5,
		);
		// The player stands on it, so step one chunk away and look back at it.
		const beside = minimapCells(
			stateAt(TOWN.cx + 1, TOWN.cy, { discovered: [chunkKey(TOWN.cx, TOWN.cy)] }),
			9,
			5,
		);
		expect(rows[2]?.[4]?.ch).toBe("@");
		expect(beside[2]?.[3]?.ch).toMatch(/[▣□]/);
	});

	// Which town it is matters less than that something is waiting there, so the
	// errand is drawn over the settlement rather than beside it.
	it("draws an errand over the settlement it was given at", () => {
		const quest: Quest = {
			id: "q1",
			name: "Timber",
			description: "Fetch it from the mill.",
			objectives: [{ kind: "have", target: "Timber", done: false }],
			progress: [],
			completed: false,
			siteId: TOWN.siteId,
		};
		const discovered = [chunkKey(TOWN.cx, TOWN.cy)];
		const withQuest = minimapCells(
			stateAt(TOWN.cx + 1, TOWN.cy, { discovered, quests: [quest] }),
			9,
			5,
		);
		expect(withQuest[2]?.[3]?.ch).toBe("!");
	});
});

/**
 * The donut, driven through the real engine rather than through a handwritten set.
 *
 * Every other test here hands `minimapCells` a `discovered` list it wrote itself, so
 * none of them could have caught this: the drawing was right all along and the list
 * it was given had a hole in it. Two rings are built around a new world — one when it
 * opens and a wider one on the first step — and only the second was ever recorded, so
 * the map came up with a dark ring between the player and the country beyond them.
 */
describe("a world that has just been opened and walked in", () => {
	it("has nothing unexplored between the player and the ground around them", () => {
		const state = createInitialState(WORLD, findSpawn(worldSeed(SEED)));
		// The real queue, handed a scheduler that runs its slices on the spot rather
		// than on the event loop, so the ring is built by the time this asserts.
		const queue = new ChunkQueue((task) => {
			task();
		});
		const engine = new GameEngine(state, {
			// The real runner, in the two cases a step reaches: building a chunk, and
			// asking for the ring around the player. Stubbing these out is what would
			// hide the bug, since reporting back is exactly where it lived.
			runEffect: (effect, e) => {
				if (effect.t === "EnsureChunk") e.getChunks().ensure(effect.cc.cx, effect.cc.cy);
				if (effect.t === "PrefetchChunks") queue.want(e, effect.around, effect.radius);
			},
		});

		// One step, whichever direction the ground allows. Twice per direction because
		// the first press only turns, and a walk that never happened prefetches nothing.
		const from = { x: state.player.x, y: state.player.y };
		for (const facing of ["down", "right", "up", "left"] as const) {
			engine.dispatch({ t: "Move", facing });
			engine.dispatch({ t: "Move", facing });
			const now = engine.getState().player;
			if (now.x !== from.x || now.y !== from.y) break;
		}
		expect(engine.getState().player).not.toMatchObject(from);

		const rows = minimapCells(engine.getState(), 5, 5);
		const blank = rows.flatMap((row, y) =>
			row.flatMap((cell, x) => (cell.ch === " " ? [`${x},${y}`] : [])),
		);
		expect(blank, "chunks were built around the player but drawn as unexplored").toEqual([]);
	});
});

/*
 * A world with an edge has to look like one.
 *
 * Reported from play: a town on the minimap that could not be reached. Two things were
 * behind it. The map drew no boundary at all, so a finite world looked infinite; and a
 * chunk is marked discovered when it is *built*, which runs a chunk ahead of the player,
 * so ground past the wall counted as found. Sites are a pure function of the seed and know
 * nothing about bounds, so `macroSite` reported settlements out there and the map drew
 * them as somewhere to go.
 */
describe("the edge of a bounded world", () => {
	/** A world eight chunks across, so a minimap can hold the whole of it and its wall. */
	function bounded(style: "cliffs" | "ocean" | "mountains" = "cliffs"): GameState {
		const base = stateAt(0, 0, { discovered: allSeen(0, 0, 8) });
		return {
			...base,
			world: {
				...base.world,
				bounds: { minX: -256, minY: -256, maxX: 255, maxY: 255, style, thickness: 8 },
			},
		};
	}

	it("draws the wall the world ends at", () => {
		// Bounds of ±256 put the rectangle's edge exactly on a chunk boundary, so the outermost
		// chunks of the world — cx and cy of -4 and 3 — are the ones the band runs through.
		const rows = minimapCells(bounded(), 13, 13);
		const middle = rows[6] as { ch: string }[];
		expect(middle[6]?.ch).toBe("@");
		// Four chunks west of the player is the wall, and everything past it is nothing.
		expect(middle[2]?.ch).toBe("#");
		expect(middle[1]?.ch).toBe(" ");
	});

	it("closes the ring on every side", () => {
		const rows = minimapCells(bounded(), 13, 13);
		const at = (x: number, y: number) => rows[y]?.[x]?.ch;
		for (const [x, y] of [
			[2, 6],
			[9, 6],
			[6, 2],
			[6, 9],
		] as const) {
			expect(at(x, y), `${x},${y}`).toBe("#");
		}
	});

	it("colours the wall by what it is made of", () => {
		const wall = (style: "cliffs" | "ocean" | "mountains") =>
			(minimapCells(bounded(style), 13, 13)[6] as { fg: unknown }[])[2]?.fg;
		expect(wall("ocean")).not.toEqual(wall("cliffs"));
		expect(wall("mountains")).not.toEqual(wall("ocean"));
	});

	it("draws no settlement past the edge, however discovered it is", () => {
		// The bug as reported. Every chunk here is marked discovered, including the ones
		// outside the world, and none of them may come back as a town.
		const rows = minimapCells(bounded(), 21, 21);
		const outside = rows
			.flatMap((row, y) => row.map((cell, x) => ({ cell, x, y })))
			.filter(({ x, y }) => Math.abs(x - 10) > 4 || Math.abs(y - 10) > 4);
		expect(outside.length).toBeGreaterThan(0);
		for (const { cell, x, y } of outside) {
			expect(cell.ch, `${x},${y}`).not.toMatch(/[▣□]/);
		}
	});

	it("shows the wall before the player has been anywhere near it", () => {
		// A finite world's shape is not a spoiler, and a map that hides its walls is one
		// where the far side of them looks like somewhere still to go.
		const unexplored = { ...bounded(), discovered: [] };
		const rows = minimapCells(unexplored, 13, 13);
		expect((rows[6] as { ch: string }[])[2]?.ch).toBe("#");
	});

	it("draws no wall at all in a world that has no edge", () => {
		const rows = minimapCells(stateAt(0, 0, { discovered: allSeen(0, 0, 8) }), 13, 13);
		expect(rows.flat().some((cell) => cell.ch === "#")).toBe(false);
	});
});

// The minimap is composited into map rows now, so it is held to the same rule as
// the terrain it is drawn over: one terminal column per glyph, everywhere. `▪`
// was the obvious village mark and is banned for exactly this reason — it has an
// emoji presentation, and a double-width cell shifts the whole rest of its row.
describe("minimap glyphs", () => {
	it("are all single-width", () => {
		for (const ch of minimapGlyphs()) {
			if (ch === " ") continue;
			expect(checkGlyph(ch), ch).toEqual({ ok: true });
			expect(stringWidth(ch), ch).toBe(1);
		}
	});
});
