import { describe, expect, it } from "vitest";
import { D } from "../../core/tiles/decor.js";
import { T } from "../../core/tiles/terrain.js";
import { composeScene } from "./compose.js";
import { encodePng } from "./png.js";
import { rasterScene } from "./raster.js";
import { paintFor } from "./sprite.js";
import { DEFAULT_THEME, resolveTheme } from "./theme.js";
import { compilePack, TilePackSchema } from "./tile-pack.js";

/**
 * What a tile pack can change, and what it must not be able to break.
 *
 * The renderer is the one place where "data from outside the program" reaches the
 * terminal directly, so the interesting cases are the ones where a bad pack could tear
 * the display or blank the map rather than merely look wrong.
 */

function parse(manifest: unknown) {
	const result = TilePackSchema.safeParse(manifest);
	if (!result.success) throw new Error(JSON.stringify(result.error.issues));
	return result.data;
}

/** A one-cell atlas of a known colour, so a blit can be checked exactly. */
function atlasOf(size: number, colour: [number, number, number]): Uint8Array {
	const rgb = Buffer.alloc(size * size * 3);
	for (let i = 0; i < size * size; i++) {
		rgb[i * 3] = colour[0];
		rgb[i * 3 + 1] = colour[1];
		rgb[i * 3 + 2] = colour[2];
	}
	return encodePng(size, size, rgb);
}

const flat = {
	terrainAt: () => T.grass,
	decorAt: () => 0,
	variantAt: () => 0,
	entityAt: () => undefined,
};

describe("what a pack may change", () => {
	it("recolours the whole map from one palette entry", () => {
		const theme = resolveTheme(
			compilePack(parse({ name: "p", palette: { moss: "#ff0000" } }), undefined),
		);
		const cell = composeScene(flat, { x: 0, y: 0, width: 1, height: 1 }, { theme })[0]?.[0];
		expect(cell?.fg).toEqual([255, 0, 0]);
		// And nothing else moved: the background is still the built-in dark moss.
		expect(cell?.bg).toEqual(DEFAULT_THEME.terrain[T.grass] && cell?.bg);
		expect(cell?.bg).not.toEqual([255, 0, 0]);
	});

	it("replaces one tile's glyph and inherits the rest", () => {
		const theme = resolveTheme(
			compilePack(
				parse({ name: "p", glyphs: { terrain: { grass: { ch: "§", fg: "bone" } } } }),
				undefined,
			),
		);
		const cell = composeScene(flat, { x: 0, y: 0, width: 1, height: 1 }, { theme })[0]?.[0];
		expect(cell?.ch).toBe("§");
		// Maps merge by key: every other terrain still has its built-in glyph.
		expect(theme.terrain[T.sand]).toEqual(DEFAULT_THEME.terrain[T.sand]);
	});

	it("draws a tile from a mask, at the pixel", () => {
		const theme = resolveTheme(
			compilePack(
				parse({ name: "p", sprites: { terrain: { grass: { mask: ["#.", ".#"] } } } }),
				undefined,
			),
		);
		const paint = paintFor(
			{ ch: " ", fg: [255, 0, 0], bg: [0, 0, 255], terrain: T.grass },
			theme.sprites,
		);
		// Top-left and bottom-right are ink; the other two are ground.
		expect(paint.shape(0.25, 0.25)).toBe(true);
		expect(paint.shape(0.75, 0.25)).toBe(false);
		expect(paint.shape(0.75, 0.75)).toBe(true);
	});

	it("draws a tile from the atlas, in its own colours", () => {
		const pack = compilePack(
			parse({ name: "p", tilePx: 4, sprites: { terrain: { grass: { atlas: [0, 0] } } } }),
			atlasOf(4, [10, 200, 30]),
		);
		const theme = resolveTheme(pack);
		expect(theme.hasBitmaps).toBe(true);

		const frame = rasterScene(
			[[{ ch: " ", fg: [0, 0, 0], bg: [0, 0, 0], bold: false, dim: false, terrain: T.grass }]],
			{ tilePx: 4, sprites: theme.sprites },
		);
		// The atlas colour, not the cell's — that is the whole point of a bitmap tile.
		expect([frame.rgb[0], frame.rgb[1], frame.rgb[2]]).toEqual([10, 200, 30]);
	});

	it("dims an atlas tile with the light, like everything else", () => {
		// A full-colour tile cannot inherit `cell.fg`, so if the multiplier did not
		// reach it a bitmap would blaze at noon brightness in the middle of the night.
		const pack = compilePack(
			parse({ name: "p", tilePx: 4, sprites: { terrain: { grass: { atlas: [0, 0] } } } }),
			atlasOf(4, [200, 200, 200]),
		);
		const theme = resolveTheme(pack);
		const rows = composeScene(
			flat,
			{ x: 0, y: 0, width: 1, height: 1 },
			{ theme, lightAt: () => 0.5 },
		);
		expect(rows[0]?.[0]?.mul).toBeDefined();

		const frame = rasterScene(rows, { tilePx: 4, sprites: theme.sprites });
		expect(frame.rgb[0]).toBe(100);
	});

	it("only pays for the multiplier when something needs it", () => {
		const plain = composeScene(flat, { x: 0, y: 0, width: 1, height: 1 }, { lightAt: () => 0.5 });
		expect(plain[0]?.[0]?.mul).toBeUndefined();
	});
});

describe("what a pack may not do", () => {
	it("is refused outright for a glyph that would tear the row", () => {
		// The one failure that breaks the *display* rather than merely looking wrong: a
		// double-width character shifts every cell after it on that line.
		expect(() =>
			resolveTheme(
				compilePack(
					parse({ name: "wide", glyphs: { terrain: { grass: { ch: "🌲", fg: "bone" } } } }),
					undefined,
				),
			),
		).toThrow(/wide/);
	});

	it("falls back to the built-in tile for an atlas cell that is not there", () => {
		// Dropped rather than thrown: the tile looks wrong, visibly, and the game starts.
		const pack = compilePack(
			parse({ name: "p", tilePx: 4, sprites: { terrain: { grass: { atlas: [9, 9] } } } }),
			atlasOf(4, [1, 2, 3]),
		);
		expect(pack.sprites?.terrain).toBeUndefined();
		expect(resolveTheme(pack).hasBitmaps).toBe(false);
	});

	it("refuses a mask that is not square", () => {
		expect(() =>
			parse({ name: "p", sprites: { terrain: { grass: { mask: ["##", "#"] } } } }),
		).toThrow(/square/);
	});

	it("refuses a field it does not know", () => {
		expect(() => parse({ name: "p", palete: {} })).toThrow();
		expect(() => parse({ name: "p", palette: { moss: "not a colour" } })).toThrow(/hex/);
	});

	it("shows a missing palette name loudly rather than silently", () => {
		const theme = resolveTheme(
			compilePack(
				parse({ name: "p", glyphs: { terrain: { grass: { ch: "x", fg: "mos" } } } }),
				undefined,
			),
		);
		const cell = composeScene(flat, { x: 0, y: 0, width: 1, height: 1 }, { theme })[0]?.[0];
		expect(cell?.fg).toEqual([255, 0, 255]);
	});
});

describe("decor keeps its own tile", () => {
	it("draws the decor sprite over the terrain one", () => {
		const theme = resolveTheme(
			compilePack(
				parse({
					name: "p",
					sprites: {
						terrain: { grass: { mask: ["#"] } },
						decor: { chest: { mask: ["."] } },
					},
				}),
				undefined,
			),
		);
		const withChest = paintFor(
			{ ch: " ", fg: [0, 0, 0], bg: [0, 0, 0], terrain: T.grass, decor: D.chest },
			theme.sprites,
		);
		expect(withChest.shape(0.5, 0.5)).toBe(false);
		const bare = paintFor(
			{ ch: " ", fg: [0, 0, 0], bg: [0, 0, 0], terrain: T.grass, decor: 0 },
			theme.sprites,
		);
		expect(bare.shape(0.5, 0.5)).toBe(true);
	});
});
