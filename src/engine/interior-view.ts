import type { Interior } from "../core/gen/features/interior.js";
import { D, decorDef } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import { T } from "../core/tiles/terrain.js";
import type { WorldView } from "./world-view.js";

/**
 * A {@link WorldView} over one interior grid.
 *
 * Interiors use their own small coordinate space starting at the origin, so the
 * same rendering, collision and field-of-view code works unchanged whether the
 * player is in a room or on a moor — the only thing that swaps is which view
 * the engine is asking.
 */
export function createInteriorView(interior: Interior): WorldView {
	const index = (x: number, y: number) =>
		x < 0 || y < 0 || x >= interior.width || y >= interior.height ? -1 : y * interior.width + x;

	return {
		terrainAt(x, y) {
			const i = index(x, y);
			return i < 0 ? T.void : (interior.terrain[i] ?? T.void);
		},
		decorAt(x, y) {
			const i = index(x, y);
			return i < 0 ? 0 : (interior.decor[i] ?? 0);
		},
		flagsAt(x, y) {
			const i = index(x, y);
			return i < 0 ? 0 : (interior.flags[i] ?? 0);
		},
		variantAt(x, y) {
			// Interiors are small and built by hand, so a positional hash is
			// enough texture without needing a stored variant array.
			return ((x * 31 + y * 17) & 0xff) >>> 0;
		},
		elevationAt() {
			// A floor is flat. Reporting "unknown" rather than a constant height
			// makes the renderer skip slope shading indoors outright, which is both
			// cheaper and the right answer — a room has no hillside.
			return -1;
		},
		isPassable(x, y) {
			const i = index(x, y);
			if (i < 0) return false;
			// Furniture blocks movement; the floor beneath it is still floor, so
			// removing the furniture would restore passability.
			if (decorDef(interior.decor[i] ?? D.none).blocks) return false;
			return ((interior.flags[i] ?? 0) & TFlag.Passable) !== 0;
		},
		blocksSight(x, y) {
			const i = index(x, y);
			if (i < 0) return true;
			return ((interior.flags[i] ?? 0) & TFlag.BlocksSight) !== 0;
		},
		isLoaded(x, y) {
			return index(x, y) >= 0;
		},
	};
}
