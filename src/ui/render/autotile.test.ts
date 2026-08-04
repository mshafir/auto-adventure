import { describe, expect, it } from "vitest";
import { T } from "../../core/tiles/terrain.js";
import { autotileGlyph, HEAVY_WALL, LIGHT_FENCE, neighborMask } from "./autotile.js";

/** The glyph a wall tile resolves to, given its four neighbours. */
function wall(north: number, east: number, south: number, west: number, self = T.stoneWall) {
	return autotileGlyph(HEAVY_WALL, neighborMask(HEAVY_WALL, self, north, east, south, west));
}

const G = T.grass;

describe("wall autotiling", () => {
	it("draws a horizontal run as a line and its ends as caps", () => {
		expect(wall(G, T.stoneWall, G, T.stoneWall)).toBe("━");
		expect(wall(G, T.stoneWall, G, G)).toBe("╺");
		expect(wall(G, G, G, T.stoneWall)).toBe("╸");
	});

	it("draws a lone wall tile as a pillar", () => {
		expect(wall(G, G, G, G)).toBe("■");
	});

	it("continues through a window, which is an opening in the wall not the end of it", () => {
		// Regression: same-terrain matching treated every opening as a wall end, so
		// a cottage front rendered as `┗╸▤■+■▤╹` — two end-caps and two isolated
		// pillars — rather than one unbroken run.
		expect(wall(G, T.window, G, T.stoneWall)).toBe("━");
		expect(wall(G, T.stoneWall, G, T.window)).toBe("━");
	});

	it("continues through a door, open or closed", () => {
		expect(wall(G, T.doorClosed, G, T.stoneWall)).toBe("━");
		expect(wall(G, T.doorOpen, G, T.stoneWall)).toBe("━");
	});

	it("renders a wall with an opening in the middle as one run", () => {
		// The shape a cottage front should make: corner, wall, window, wall, corner.
		const front = [
			wall(T.stoneWall, T.stoneWall, G, G),
			wall(G, T.window, G, T.stoneWall),
			wall(G, T.stoneWall, G, T.window),
			wall(T.stoneWall, G, G, T.stoneWall),
		];
		expect(front.join("")).toBe("┗━━┛");
	});

	it("does not connect a timber wall to a stone one", () => {
		// Different materials meeting should still read as two walls.
		expect(wall(G, T.woodWall, G, G, T.stoneWall)).toBe("■");
	});

	it("leaves fences matching only their own kind", () => {
		// A fence is not part of the wall plane, so an adjacent door must not
		// silently extend it.
		const mask = neighborMask(LIGHT_FENCE, T.fence, G, T.doorClosed, G, G);
		expect(autotileGlyph(LIGHT_FENCE, mask)).toBe("○");
	});
});
