import type { DecorId } from "../../core/tiles/decor.js";
import { type ChunkProvider, createWorldView, type WorldView } from "../../engine/world-view.js";
import type { EntityGlyph, OverlayGlyph, TileSource } from "./compose.js";

export interface WorldSourceOptions {
	entityAt?: (x: number, y: number) => EntityGlyph | undefined;
	overlayAt?: (x: number, y: number) => OverlayGlyph | undefined;
	/**
	 * Decor the world itself does not carry.
	 *
	 * Returning `undefined` falls through to the generated decor, so this adds rather
	 * than replaces. It exists for authored items lying in the open: a placement is not
	 * part of the chunk — it is state, and it is conditional — so it cannot be stamped
	 * into the decor array, but a thing on the floor that is not drawn is a thing
	 * nobody finds.
	 */
	decorAt?: (x: number, y: number) => DecorId | undefined;
}

/**
 * Adapt a {@link WorldView} to the compositor's {@link TileSource}.
 *
 * Deliberately thin: the compositor asks in world coordinates and the view
 * answers in world coordinates, so autotile neighbour probes resolve across
 * chunk edges without either side knowing a boundary was crossed.
 */
export function tileSourceFrom(view: WorldView, options: WorldSourceOptions = {}): TileSource {
	return {
		terrainAt: (x, y) => view.terrainAt(x, y),
		decorAt: (x, y) => options.decorAt?.(x, y) ?? view.decorAt(x, y),
		variantAt: (x, y) => view.variantAt(x, y),
		elevationAt: (x, y) => view.elevationAt(x, y),
		entityAt: (x, y) => options.entityAt?.(x, y),
		overlayAt: (x, y) => options.overlayAt?.(x, y),
	};
}

export function createWorldTileSource(
	provider: ChunkProvider,
	options: WorldSourceOptions = {},
): TileSource {
	return tileSourceFrom(createWorldView(provider), options);
}
