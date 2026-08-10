import { describe, expect, it } from "vitest";
import { terrainByKey } from "../../core/tiles/terrain.js";
import { DEFAULT_THEME, resolveTheme, type TileTheme } from "./theme.js";
import { compilePack, TilePackSchema } from "./tile-pack.js";
import { PREVIEW_HEIGHT, PREVIEW_SCENE, PREVIEW_WIDTH, previewRows } from "./tile-preview.js";

/**
 * Built through the manifest rather than by hand, because that is the only path a real
 * pack takes — and the difference matters here: `autotile` is a *name* in a file and a
 * resolved set in a theme, so a fixture written directly would test a shape no pack ever
 * has.
 */
function themeFrom(manifest: unknown): TileTheme {
	return resolveTheme(compilePack(TilePackSchema.parse(manifest), undefined));
}

describe("the tile preview", () => {
	it("draws every cell of the scene", () => {
		const rows = previewRows(DEFAULT_THEME);
		expect(rows).toHaveLength(PREVIEW_HEIGHT);
		for (const row of rows) expect(row).toHaveLength(PREVIEW_WIDTH);
	});

	it("names only terrain that exists", () => {
		// The scene is written as terrain *keys*, which is the one thing in it that can go
		// stale silently: a renamed terrain draws the miss sentinel rather than failing, and
		// the sentinel is a blank — which is indistinguishable on screen from a road, whose
		// glyph is legitimately a space over a coloured background.
		for (const row of PREVIEW_SCENE) {
			for (const key of row) expect(terrainByKey(key), key).toBeDefined();
		}
	});

	it("is one column per cell, or the rows would not line up", () => {
		for (const row of previewRows(DEFAULT_THEME)) {
			for (const cell of row) expect([...cell.ch]).toHaveLength(1);
		}
	});

	it("draws a wall as its joined form rather than an isolated stub", () => {
		// `stoneWall` is an autotile, and a preview has no neighbours to read. Drawn as the
		// unconnected form, every pack's masonry looks broken in the chooser and correct in
		// the game, which is the worst way round.
		const theme = themeFrom({
			name: "test",
			glyphs: { terrain: { stoneWall: { ch: "#", fg: "stone", autotile: "heavyWall" } } },
		});
		const wall = previewRows(theme)[2]?.[3];
		expect(wall).toBeDefined();
		// Whatever the set draws for "joined on all four sides" — not the bare `ch`.
		expect(wall?.ch).not.toBe("#");
	});

	it("takes its colours from the pack, which is the whole point of showing it", () => {
		const plain = previewRows(DEFAULT_THEME);
		const recoloured = previewRows(
			themeFrom({ name: "test", palette: { deep: "#ff0000", abyss: "#ff0000" } }),
		);
		expect(recoloured[0]?.[0]?.fg).not.toEqual(plain[0]?.[0]?.fg);
		expect(recoloured[0]?.[0]?.fg).toEqual([255, 0, 0]);
	});

	it("shows texture where a pack varies a tile, rather than repeating one glyph", () => {
		const theme = themeFrom({
			name: "test",
			glyphs: { terrain: { grass: { ch: ["a", "b", "c", "d"], fg: "moss", bg: "mossDark" } } },
		});
		// Row 0 has grass at columns 3, 8 and 11, which are three different variants.
		const row = previewRows(theme)[0] as { ch: string }[];
		expect(new Set([row[3]?.ch, row[8]?.ch, row[11]?.ch]).size).toBeGreaterThan(1);
	});
});
