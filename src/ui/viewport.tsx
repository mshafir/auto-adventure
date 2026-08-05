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
import { resolveTileMode, type TileMode } from "./render/mode.js";
import { rasterScene } from "./render/raster.js";
import { expandScene, TILE_WIDTH, tilesAcross } from "./render/scale.js";

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

function GlyphViewport({ source, camera, options }: ViewportProps) {
	const depth = colorDepth();
	const rows = useMemo(
		// The camera is in tiles; expansion to columns happens after compositing,
		// so lighting, autotiling and field of view all still work per tile. The
		// camera is also the scene's world origin, which is what keeps texture
		// placement fixed to the ground instead of to the viewport.
		() =>
			encodeScene(expandScene(composeScene(source, camera, options), TILE_WIDTH, camera), depth),
		[source, camera, options, depth],
	);

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
 * The image itself is written straight to the stream, and it has to be. An APC
 * graphics escape measures *hundreds* of columns wide, and Ink composes the map
 * and the side panel as siblings on one screen row: a line carrying the escape
 * pushes everything to its right out of place, painting over the panel. Ink's
 * `Transform` does not save this. It bypasses layout, not row composition, so
 * the oversized line still lands in the frame — which is exactly how the panel
 * ended up with map colours bleeding across it.
 *
 * Writing during render rather than from an effect is deliberate. Ink emits its
 * frame from the reconciler's `resetAfterCommit`, which runs *before* layout
 * effects, so an effect would upload the image only after the placeholders
 * referencing it had already been painted — and on the first frame there would
 * be no image at all.
 *
 * Memoising the upload is not just an optimisation either: an image stays
 * resident in the terminal until it is replaced, so a re-render that does not
 * change the scene — a menu opening, a key bar changing — costs no pixels at
 * all, only the placeholder text.
 */
function KittyViewport({ source, camera, options, columns, rows: maxRows }: ViewportProps) {
	const { write } = useStdout();

	const rows = useMemo(() => {
		const frame = rasterScene(composeScene(source, camera, options));
		// The image fills exactly the rectangle the layout allowed, and the
		// placeholder grid is that same rectangle. Sizing either from the image's
		// pixels instead lets it come out wider than the space available, and the
		// map box is `flexShrink={0}`, so the surplus is not clipped.
		write(
			transmitFrame({
				rgb: frame.rgb,
				width: frame.width,
				height: frame.height,
				columns,
				rows: maxRows,
			}),
		);
		return placeholderRows(columns, maxRows);
	}, [source, camera, options, columns, maxRows, write]);

	// Leave nothing behind in the terminal when the map goes away.
	useEffect(() => () => write(deleteFrame()), [write]);

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
