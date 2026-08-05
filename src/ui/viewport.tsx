import { Box, Text, useStdout } from "ink";
import { useEffect, useMemo } from "react";
import { encodeScene } from "./render/ansi.js";
import { type ColorDepth, detectColorDepth } from "./render/color.js";
import {
	type Camera,
	type ComposeOptions,
	composeScene,
	type TileSource,
} from "./render/compose.js";
import { deleteFrame, placeholderRows, transmitFrame } from "./render/kitty.js";
import type { MiniCell } from "./render/minimap-data.js";
import { cellPixels, resolveTileMode, type TileMode, tilePixels } from "./render/mode.js";
import { overlayMinimap, paintMinimap } from "./render/overlay.js";
import { rasterScene } from "./render/raster.js";
import { expandScene, TILE_WIDTH, tilesAcross } from "./render/scale.js";
import { queueGraphics } from "./render/sync-output.js";

export { TILE_WIDTH, tilesAcross };

let cachedDepth: ColorDepth | undefined;
let cachedMode: TileMode | undefined;

/** Resolved once: the mode cannot change without the process restarting. */
export function tileMode(): TileMode {
	if (cachedMode === undefined) cachedMode = resolveTileMode().mode;
	return cachedMode;
}

/** Test seam, matching {@link setColorDepth}. */
export function setTileMode(mode: TileMode | undefined): void {
	cachedMode = mode;
}

export function colorDepth(): ColorDepth {
	if (cachedDepth === undefined) cachedDepth = detectColorDepth();
	return cachedDepth;
}

/** Test seam: lets suites pin a depth without touching the environment. */
export function setColorDepth(depth: ColorDepth | undefined): void {
	cachedDepth = depth;
}

export interface ViewportProps {
	readonly source: TileSource;
	readonly camera: Camera;
	readonly options?: ComposeOptions;
	/**
	 * The cell rectangle the map may occupy.
	 *
	 * Passed in rather than derived, because only the layout knows it. The image
	 * renderer must not exceed it: the map box does not shrink, so anything wider
	 * runs into the side panel instead of being clipped.
	 */
	readonly columns: number;
	readonly rows: number;
	/**
	 * The minimap, composited into the corner of the frame.
	 *
	 * Passed in rather than read from the store because it is *data*, and both
	 * renderers paint the same data two different ways — into the cell grid here,
	 * into the pixel buffer there. Undefined when the map is too small to spare
	 * the room for it.
	 */
	readonly minimap?: readonly (readonly MiniCell[])[];
}

/**
 * Renders the map as one `<Text>` per row carrying pre-encoded ANSI.
 *
 * At 120x40 the previous per-cell approach built 4,800 React elements and as
 * many Yoga layout nodes every frame; this builds 40. Ink passes the escape
 * sequences through untouched because it measures with `string-width`.
 */
export function Viewport(props: ViewportProps) {
	// Dispatch rather than branch inside one component, so the mode that is not
	// in use does no compositing at all.
	return tileMode() === "kitty" ? <KittyViewport {...props} /> : <GlyphViewport {...props} />;
}

function GlyphViewport({ source, camera, options, minimap }: ViewportProps) {
	const depth = colorDepth();
	const rows = useMemo(() => {
		// The camera is in tiles; expansion to columns happens after compositing,
		// so lighting, autotiling and field of view all still work per tile. The
		// camera is also the scene's world origin, which is what keeps texture
		// placement fixed to the ground instead of to the viewport.
		const cells = expandScene(composeScene(source, camera, options), TILE_WIDTH, camera);
		// After expansion, not before: the minimap is one character per chunk and
		// widening it 2:1 would stretch it the way the map needs and it does not.
		return encodeScene(minimap ? overlayMinimap(cells, minimap) : cells, depth);
	}, [source, camera, options, depth, minimap]);

	return (
		<Box flexDirection="column" flexShrink={0}>
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
				<Text key={i} wrap="truncate">
					{row}
				</Text>
			))}
		</Box>
	);
}

/**
 * Renders the map as an image, placed through Unicode placeholder cells.
 *
 * Only the placeholders go through Ink. They are ordinary text — `string-width`
 * reports 1 for U+10EEEE and 0 for its diacritics — so Ink lays them out and
 * repaints them like any other row.
 *
 * The image itself never goes through Ink, and cannot. An APC graphics escape
 * measures *hundreds* of columns wide, so a line carrying one pushes everything
 * to its right out of place. Ink's `Transform` does not save this: it bypasses
 * layout, not row composition, so the oversized line still lands in the frame.
 *
 * It is *queued* rather than written, though, so that it rides out inside the
 * same synchronized update as the frame that displays it. Writing it straight to
 * the stream made every move two presentations — the new image against the
 * previous frame's text, then the text — and the first of those is a frame
 * nobody asked to see.
 *
 * Queueing during render rather than from an effect is deliberate. Ink emits its
 * frame from the reconciler's `resetAfterCommit`, which runs *before* layout
 * effects, so an effect would queue the image only after the frame it belonged
 * to had already gone out.
 *
 * Memoising the upload is not just an optimisation either: an image stays
 * resident in the terminal until it is replaced, so a re-render that does not
 * change the scene — a menu opening, a key bar changing — costs no pixels at
 * all, only the placeholder text.
 */
function KittyViewport({
	source,
	camera,
	options,
	columns,
	rows: maxRows,
	minimap,
}: ViewportProps) {
	const { write } = useStdout();

	const rows = useMemo(() => {
		// Sized from the terminal's own cell, not from a constant. A fixed sixteen
		// pixels is smaller than a cell on any modern terminal, so tiles came out
		// smaller than the glyph renderer's and the map showed two and a half times
		// as much world at a third of the size.
		const frame = rasterScene(composeScene(source, camera, options), { tilePx: tilePixels() });
		// Into the pixels, before the image goes out. A chunk gets one cell of the
		// terminal, doubled across, which is the same room the glyph path gives it —
		// so the minimap covers the same patch of screen in either renderer, and
		// changing renderer does not change how much world it shows.
		if (minimap) {
			const cell = cellPixels();
			paintMinimap(frame, minimap, {
				chunk: { width: cell.width * TILE_WIDTH, height: cell.height },
			});
		}
		// Queued rather than written, so it lands inside the same synchronized
		// update as the frame that displays it. Writing it here directly made the
		// terminal present twice per move — once with the new image under the
		// previous frame's text — which is what the flicker was.
		//
		// The image fills exactly the rectangle the layout allowed, and the
		// placeholder grid is that same rectangle. Sizing either from the image's
		// pixels instead lets it come out wider than the space available, and the
		// map box is `flexShrink={0}`, so the surplus is not clipped.
		queueGraphics(
			transmitFrame({
				rgb: frame.rgb,
				width: frame.width,
				height: frame.height,
				columns,
				rows: maxRows,
			}),
		);
		return placeholderRows(columns, maxRows);
	}, [source, camera, options, columns, maxRows, minimap]);

	// Leave nothing behind in the terminal when the map goes away.
	useEffect(() => () => write(deleteFrame()), [write]);

	return (
		<Box flexDirection="column" flexShrink={0}>
			{rows.map((row, i) => (
				/*
				 * No `wrap="truncate"` here, and it must not come back. A placeholder
				 * is U+10EEEE — outside the BMP, so two UTF-16 code units — and Ink's
				 * truncation counts code units rather than display width. A row of
				 * 129 placeholders was cut to 129 *units*, which is 64 placeholders,
				 * and the side panel was then composited into the middle of the map
				 * row at column 64. Captured and counted, not guessed.
				 *
				 * Nothing is lost by dropping it: the row is built to be exactly as
				 * wide as the rectangle the layout allowed, so there is never
				 * anything to truncate.
				 */
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
				<Text key={i}>{row}</Text>
			))}
		</Box>
	);
}

/** Centre the camera on a world position, which is correct for an open world. */
export function cameraCenteredOn(
	position: readonly [number, number],
	width: number,
	height: number,
): Camera {
	return {
		x: position[0] - Math.floor(width / 2),
		y: position[1] - Math.floor(height / 2),
		width,
		height,
	};
}
