import type { GameMap } from "../map/map.schema.js";

export function getMapDimensions(map: GameMap) {
	const rows = map.mapTiles.split("\n");
	return {
		width: rows[0].length,
		height: rows.length,
	};
}
