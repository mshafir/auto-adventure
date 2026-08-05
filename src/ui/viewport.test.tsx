import { render } from "ink-testing-library";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { afterAll, describe, expect, it } from "vitest";
import { T } from "../core/tiles/terrain.js";
import type { TileSource } from "./render/compose.js";
import type { MiniCell } from "./render/minimap-data.js";
import { PAL } from "./render/palette.js";
import { cameraCenteredOn, setColorDepth, TILE_WIDTH, tilesAcross, Viewport } from "./viewport.js";

// Pin the depth so the assertions do not depend on the runner's environment.
setColorDepth("truecolor");
afterAll(() => setColorDepth(undefined));

const flatWorld: TileSource = {
	terrainAt: () => T.grass,
	decorAt: () => 0,
	variantAt: () => 0,
	entityAt: () => undefined,
};

function rowsOf(
	width: number,
	height: number,
	minimap?: readonly (readonly MiniCell[])[],
): string[] {
	const { lastFrame, unmount } = render(
		<Viewport
			source={flatWorld}
			camera={{ x: 0, y: 0, width, height }}
			columns={width * TILE_WIDTH}
			rows={height}
			{...(minimap ? { minimap } : {})}
		/>,
	);
	const rows = (lastFrame() ?? "").split("\n").filter((row) => row.length > 0);
	unmount();
	return rows;
}

describe("tile width", () => {
	it("draws each tile TILE_WIDTH columns wide", () => {
		// Guards the wiring, not the expander: if the viewport ever stopped calling
		// expandScene the world would silently revert to being stretched 2:1 and
		// every other test would still pass.
		const rows = rowsOf(12, 4);
		expect(rows).toHaveLength(4);
		for (const row of rows) {
			expect(stringWidth(stripAnsi(row))).toBe(12 * TILE_WIDTH);
		}
	});

	it("converts terminal columns to tiles without ever overflowing them", () => {
		// Overflow is the dangerous direction: one column too many makes Ink wrap
		// every row, which doubles the rendered height and reads as flicker.
		for (const columns of [20, 21, 79, 80, 120, 121]) {
			expect(tilesAcross(columns) * TILE_WIDTH).toBeLessThanOrEqual(columns);
		}
	});

	it("never reports zero tiles, however narrow the terminal", () => {
		for (const columns of [0, 1, 2, 3]) {
			expect(tilesAcross(columns)).toBeGreaterThanOrEqual(1);
		}
	});

	it("keeps the player centred in tile space", () => {
		const camera = cameraCenteredOn([100, 50], tilesAcross(80), 20);
		expect(camera.x + Math.floor(camera.width / 2)).toBe(100);
		expect(camera.y + Math.floor(camera.height / 2)).toBe(50);
	});
});

describe("the minimap overlay", () => {
	const mini: MiniCell[][] = Array.from({ length: 5 }, () =>
		Array.from({ length: 9 }, () => ({ ch: "~", fg: PAL.deep, bold: false, fill: true })),
	);

	it("appears in the map's own rows", () => {
		const rows = rowsOf(30, 16, mini);
		const plain = rows.map((row) => stripAnsi(row));
		expect(plain.some((row) => row.includes("╭"))).toBe(true);
		expect(plain.some((row) => row.includes("~~~~~~~~~"))).toBe(true);
	});

	/*
	 * The whole reason it is composited rather than laid out. A box beside the map
	 * would be an Ink sibling, and a sibling on a row of kitty placeholders makes
	 * Ink cut that row in half. Painting into the scene means every row is still
	 * exactly as wide as it was without the minimap.
	 */
	it("does not change the width of a single row", () => {
		const bare = rowsOf(30, 16).map((row) => stringWidth(stripAnsi(row)));
		const over = rowsOf(30, 16, mini).map((row) => stringWidth(stripAnsi(row)));
		expect(over).toEqual(bare);
	});
});
