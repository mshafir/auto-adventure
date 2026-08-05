import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import { createInitialState, type GameState, type Quest } from "../../core/rules/state.js";
import { CHUNK, chunkKey } from "../../core/world/coords.js";
import { isSettlement, macroSite } from "../../core/world/macro.js";
import { checkGlyph } from "./glyph-safety.js";
import { minimapCells, minimapGlyphs } from "./minimap-data.js";

const SEED = hashString("vale");
const WORLD = { id: "t", name: "T", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" };

/** A settled chunk in this seed, so the test marks somewhere that exists. */
function findSettlement(): { cx: number; cy: number; siteId: number } {
	for (let cx = -6; cx <= 6; cx++) {
		for (let cy = -6; cy <= 6; cy++) {
			const site = macroSite(SEED, cx, cy);
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
