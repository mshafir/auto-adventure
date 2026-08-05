import { Box } from "ink";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import { T } from "../core/tiles/terrain.js";
import type { TileSource } from "./render/compose.js";
import { PLACEHOLDER } from "./render/kitty.js";
import { flushGraphics } from "./render/sync-output.js";
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
	// `lastFrame` is what Ink laid out. The image is not in it and must not be:
	// it is queued for the synchronized update that carries the frame, which the
	// real stdout wrapper prepends. Here that queue is read directly.
	const out = { frame: lastFrame() ?? "", all: frames.join("") + flushGraphics() };
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

	/*
	 * And still exactly that rectangle on a tall terminal, which it was not.
	 *
	 * Ink lays a row out with `wrap-ansi`, which adds up `string-width` per
	 * character. The first thirty row-anchor diacritics measure 0 on their own; from
	 * `U+0483` on they measure 1. So every row from the thirtieth down added up to
	 * one column more than it occupied and Ink folded its last cell onto the next
	 * line — 162 cells and a stray 1, with the shell's scrollback showing through the
	 * gaps between them.
	 *
	 * Thirty is the boundary, so this has to run past it to mean anything: at five
	 * rows, and at twenty-nine, the map was always fine.
	 */
	it("keeps every row whole past the thirtieth, where the diacritics change block", () => {
		for (const rows of [29, 30, 31, 48, 62]) {
			const { frame } = frameOf(60, rows, 20, 8);
			const lines = frame.split("\n").filter((l) => l.includes(PLACEHOLDER));
			expect(lines, `${rows} rows`).toHaveLength(rows);
			for (const [index, line] of lines.entries()) {
				expect(line.split(PLACEHOLDER).length - 1, `${rows} rows, row ${index}`).toBe(60);
			}
		}
	});

	// The image and the placeholder grid have to agree, or the terminal maps the
	// wrong part of the picture into each cell and the map comes out sheared.
	it("tells the terminal the same rectangle it draws placeholders for", () => {
		const { all } = frameOf(30, 5);
		expect(all).toContain("c=30");
		expect(all).toContain("r=5");
	});

	/*
	 * Queued during render, not written. The stdout wrapper prepends the queue to
	 * Ink's next frame, so the image and the placeholders that display it reach
	 * the terminal in one synchronized update — where writing it directly made
	 * every move two presentations, the first of them the new image sitting under
	 * the previous frame's text.
	 */
	it("queues the image rather than writing it beside the frame", () => {
		setTileMode("kitty");
		const { lastFrame, frames, unmount } = render(
			<Box width={30}>
				<Viewport
					source={world}
					camera={{ x: 0, y: 0, width: 20, height: 4 }}
					columns={30}
					rows={4}
				/>
			</Box>,
		);
		const written = frames.join("") + (lastFrame() ?? "");
		const queued = flushGraphics();
		unmount();

		expect(written).not.toContain(`${ESC}_G`);
		expect(queued).toContain(`${ESC}_G`);
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
