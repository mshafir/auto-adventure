import { Box } from "ink";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import { T } from "../core/tiles/terrain.js";
import type { TileSource } from "./render/compose.js";
import { PLACEHOLDER } from "./render/kitty.js";
import { setTileMode, Viewport } from "./viewport.js";

const world: TileSource = {
	terrainAt: () => T.grass,
	decorAt: () => 0,
	variantAt: () => 0,
	entityAt: () => undefined,
};

const ESC = "";

function frameOf(columns: number, rows: number, tilesW = 20, tilesH = 8) {
	setTileMode("kitty");
	const { lastFrame, frames, unmount } = render(
		// A parent of the same width, as the app gives it, so overflow shows up as
		// a line wider than the box rather than being invisible.
		<Box width={columns}>
			<Viewport
				source={world}
				camera={{ x: 0, y: 0, width: tilesW, height: tilesH }}
				columns={columns}
				rows={rows}
			/>
		</Box>,
	);
	// `lastFrame` is what Ink laid out; `all` also contains the direct writes the
	// image goes out on, which never belong to a frame.
	const out = { frame: lastFrame() ?? "", all: frames.join("") };
	unmount();
	return out;
}

afterEach(() => setTileMode(undefined));

describe("KittyViewport", () => {
	/**
	 * The bug this pins, and it is the one that painted map colours across the
	 * side panel. An APC graphics escape is hundreds of columns wide by
	 * `string-width`, and Ink composes the map and the panel as siblings on one
	 * screen row — so a frame line carrying the image shoves everything right of
	 * it out of place. `Transform` does not help: it bypasses layout, not row
	 * composition.
	 */
	it("never puts the image in a frame line", () => {
		for (const columns of [40, 61, 86, 87]) {
			const { frame } = frameOf(columns, 6);
			expect(frame, `${columns} columns`).not.toContain(`${ESC}_G`);
			for (const line of frame.split("\n")) {
				expect(stringWidth(line), `${columns} columns`).toBeLessThanOrEqual(columns);
			}
		}
	});

	it("emits exactly the rectangle it was given", () => {
		const { frame } = frameOf(30, 5);
		const lines = frame.split("\n").filter((l) => l.includes(PLACEHOLDER));
		expect(lines).toHaveLength(5);
		for (const line of lines) {
			expect(line.split(PLACEHOLDER).length - 1).toBe(30);
		}
	});

	// The image and the placeholder grid have to agree, or the terminal maps the
	// wrong part of the picture into each cell and the map comes out sheared.
	it("tells the terminal the same rectangle it draws placeholders for", () => {
		const { all } = frameOf(30, 5);
		expect(all).toContain("c=30");
		expect(all).toContain("r=5");
	});

	// Ink writes its frame from the reconciler, before layout effects run, so an
	// upload from an effect would arrive after the cells referencing it.
	it("uploads the image before the placeholders that display it", () => {
		const { all } = frameOf(20, 4);
		expect(all.indexOf(`${ESC}_G`)).toBeGreaterThanOrEqual(0);
		expect(all.indexOf(`${ESC}_G`)).toBeLessThan(all.indexOf(PLACEHOLDER));
	});

	it("falls back to glyphs when the mode says so", () => {
		setTileMode("glyph");
		const { lastFrame, frames, unmount } = render(
			<Viewport
				source={world}
				camera={{ x: 0, y: 0, width: 10, height: 3 }}
				columns={20}
				rows={3}
			/>,
		);
		const out = (lastFrame() ?? "") + frames.join("");
		unmount();
		expect(out).not.toContain(PLACEHOLDER);
		expect(out).not.toContain(`${ESC}_G`);
	});
});
