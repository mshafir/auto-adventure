import { Box, Text } from "ink";
import { useMemo } from "react";
import { encodeScene } from "./render/ansi.js";
import { type ColorDepth, detectColorDepth } from "./render/color.js";
import {
	type Camera,
	type ComposeOptions,
	composeScene,
	type TileSource,
} from "./render/compose.js";
import { expandScene, TILE_WIDTH, tilesAcross } from "./render/scale.js";

export { TILE_WIDTH, tilesAcross };

let cachedDepth: ColorDepth | undefined;

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
export function Viewport({ source, camera, options }: ViewportProps) {
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
