import { describe, expect, it } from "vitest";
import type { TerraformEdit } from "../../../scenario/terraform.js";
import { T } from "../../tiles/terrain.js";
import { authoredTiles, terraformBounds } from "./authored.js";

type Path = Extract<TerraformEdit, { t: "Path" }>;

function path(
	from: [number, number],
	to: [number, number],
	rest: { readonly width?: number; readonly surface?: Path["surface"] } = {},
): Path {
	return {
		t: "Path",
		id: "lane",
		from: { x: from[0], y: from[1] },
		to: { x: to[0], y: to[1] },
		surface: rest.surface ?? "path",
		...(rest.width !== undefined ? { width: rest.width } : {}),
	};
}

describe("authoredTiles", () => {
	it("lays a straight path one tile wide by default", () => {
		expect([...authoredTiles([path([0, 0], [3, 0])]).keys()].sort()).toEqual([
			"0,0",
			"1,0",
			"2,0",
			"3,0",
		]);
	});

	/*
	 * A square brush rather than a perpendicular one. Perpendicular widening is what a road
	 * really wants, but it needs a direction per segment and leaves gaps at the corners of a
	 * stepped diagonal — so a wide diagonal road would come out perforated. The cost of the
	 * square brush is that a wide path fans one tile past each of its ends, which reads as a
	 * road spreading slightly where it arrives somewhere.
	 */
	it("widens a path symmetrically about its line", () => {
		const tiles = authoredTiles([path([0, 0], [1, 0], { width: 3 })]);
		for (const at of ["0,-1", "0,0", "0,1", "1,-1", "1,0", "1,1"]) {
			expect(tiles.has(at), at).toBe(true);
		}
	});

	/*
	 * Bresenham draws the visually straightest diagonal, which is a staircase of diagonal
	 * steps — tiles touching only at their corners. Movement is four-directional, so that is a
	 * road that looks like a road and cannot be walked down.
	 */
	it("steps a diagonal path so every tile has an orthogonal neighbour", () => {
		const tiles = authoredTiles([path([0, 0], [4, 4])]);
		const on = new Set(tiles.keys());
		for (const at of on) {
			const comma = at.indexOf(",");
			const x = Number(at.slice(0, comma));
			const y = Number(at.slice(comma + 1));
			const neighbours = [
				`${x + 1},${y}`,
				`${x - 1},${y}`,
				`${x},${y + 1}`,
				`${x},${y - 1}`,
			].filter((next) => on.has(next));
			expect(neighbours.length, `${at} is only reachable diagonally`).toBeGreaterThan(0);
		}
	});

	it("gives each surface its own terrain", () => {
		const surfaces = (["path", "dirt", "cobble"] as const).map((surface) =>
			authoredTiles([path([0, 0], [0, 0], { surface })]).get("0,0"),
		);
		expect(new Set(surfaces).size).toBe(3);
		expect(surfaces).toEqual([T.path, T.dirtRoad, T.cobbleRoad]);
	});

	it("makes a bridge out of planks", () => {
		const tiles = authoredTiles([
			{ t: "Bridge", id: "span", from: { x: 0, y: 0 }, to: { x: 2, y: 0 } },
		]);
		expect(tiles.get("1,0")).toBe(T.bridge);
	});

	it("clears a disc of ground", () => {
		const tiles = authoredTiles([{ t: "Clearing", id: "glade", at: { x: 0, y: 0 }, radius: 1 }]);
		expect([...tiles.keys()].sort()).toEqual(["-1,0", "0,-1", "0,0", "0,1", "1,0"]);
		expect(tiles.get("0,0")).toBe(T.grass);
	});

	it("lets a later edit win where two overlap", () => {
		// The only rule an author can predict when two shapes cross. Resolved here rather than
		// wherever the tiles are read, so it is a property of the data.
		const tiles = authoredTiles([
			path([0, 0], [0, 0]),
			{ t: "Bridge", id: "span", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
		]);
		expect(tiles.get("0,0")).toBe(T.bridge);
	});

	it("has nothing to say about no edits at all", () => {
		expect(authoredTiles([]).size).toBe(0);
	});
});

describe("terraformBounds", () => {
	it("covers every tile the edits touch", () => {
		// A width-3 path from (2,3) to (5,3) reaches x 1..6, because the brush is square and so
		// fans a tile past each end. See `authoredTiles`.
		expect(terraformBounds([path([2, 3], [5, 3], { width: 3 })])).toEqual({
			x: 1,
			y: 2,
			w: 6,
			h: 3,
		});
	});

	it("spans several edits at once", () => {
		expect(
			terraformBounds([
				path([0, 0], [0, 0]),
				{ t: "Clearing", id: "glade", at: { x: 10, y: 10 }, radius: 2 },
			]),
		).toEqual({ x: 0, y: 0, w: 13, h: 13 });
	});

	it("is undefined when there is nothing to invalidate", () => {
		// The common case — most phases change no ground — and the caller skips the rebuild
		// rather than dropping chunks over an empty rectangle.
		expect(terraformBounds([])).toBeUndefined();
	});

	it("handles negative coordinates, since the world has no origin corner", () => {
		expect(terraformBounds([path([-5, -5], [-3, -5])])).toEqual({ x: -5, y: -5, w: 3, h: 1 });
	});
});
