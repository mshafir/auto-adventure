import { Box, Text, Transform } from "ink";
import { useMemo } from "react";
import { encodeScene } from "./render/ansi.js";
import { type ColorDepth, detectColorDepth } from "./render/color.js";
import {
	type Camera,
	type ComposeOptions,
	composeScene,
	type TileSource,
} from "./render/compose.js";
import { placeholderRows, transmitFrame } from "./render/kitty.js";
import { cellPixels, resolveTileMode, type TileMode } from "./render/mode.js";
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
 * The image data cannot go inline: `string-width` measures an APC graphics
 * escape as 24 columns, so Ink would lay every row out too wide and the map
 * would shear. It rides instead on Ink's `Transform`, which rewrites a line's
 * final output *after* layout has been computed from the line it wrapped — so
 * Ink lays out a grid of placeholders, each one column wide, and the pixels are
 * smuggled onto the front of the first row.
 *
 * That also makes the upload atomic with the repaint. `sync-output.ts` brackets
 * each of Ink's writes in DEC 2026, and because the image is part of the same
 * write, the terminal never presents a frame where the placeholders have been
 * drawn but their image has not arrived.
 */
function KittyViewport({ source, camera, options }: ViewportProps) {
	const cell = cellPixels();

	const { transmit, rows } = useMemo(() => {
		const scene = composeScene(source, camera, options);
		const frame = rasterScene(scene);
		// The cell rectangle the image is asked to fill. Rounded up, so the image
		// is never given fewer cells than it has tiles and squeezed.
		const columns = Math.max(1, Math.ceil(frame.width / cell.width));
		const cellRows = Math.max(1, Math.ceil(frame.height / cell.height));
		return {
			transmit: transmitFrame({
				rgb: frame.rgb,
				width: frame.width,
				height: frame.height,
				columns,
				rows: cellRows,
			}),
			rows: placeholderRows(columns, cellRows),
		};
	}, [source, camera, options, cell.width, cell.height]);

	return (
		<Box flexDirection="column" flexShrink={0}>
			{rows.map((row, i) => {
				const text = (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
					<Text key={i} wrap="truncate">
						{row}
					</Text>
				);
				// Only the first row carries the upload; the rest are plain text.
				return i === 0 ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
					<Transform key={i} transform={(line) => transmit + line}>
						{text}
					</Transform>
				) : (
					text
				);
			})}
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
