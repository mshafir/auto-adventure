import { Text } from "ink";
import type { GameMap } from "../map/map.schema.js";
import { blankTile, type Tile } from "../map/tilesets/basic.js";
import { TileSets } from "../map/tilesets/tilesets.js";

export function getTileSymbol(
	layer: string,
	position: readonly [number, number]
) {
	const splitLayer = layer.split("\n");
	if (
		position[0] < 0 ||
		position[1] < 0 ||
		position[1] >= splitLayer.length ||
		position[0] >= splitLayer[position[1]].length
	) {
		return undefined;
	}
	return splitLayer[position[1]][position[0]];
}

export function getMapTile(
	map: GameMap,
	position: readonly [number, number]
): Tile & { symbol: string } {
	const symbol = getTileSymbol(map.mapTiles, position);
	if (!symbol) {
		return blankTile;
	}
	if (/[0-9]/.test(symbol)) {
		const object = map.objects
			.map((o, i) => ({ ...o, number: i }))
			.find((o) => o.number === Number(symbol));
		if (object) {
			return {
				symbol,
				description: object.description,
				passable: false,
				render: () => <Text>{symbol}</Text>,
			};
		}
	}
	const tileset =
		TileSets[map.tileset as keyof typeof TileSets] ?? TileSets.basic;
	return {
		symbol,
		...(tileset[symbol] ?? blankTile),
	};
}
