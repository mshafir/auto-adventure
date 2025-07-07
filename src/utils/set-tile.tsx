import type { GameMap } from "../map/map.schema.js";
import { stringToCharArray } from "./find-tile.js";

export function setTileSymbol(
	map: GameMap,
	position: [number, number],
	symbol: string
) {
	const { mapTiles } = map;
	const tileSymbols = mapTiles.split("\n").map((r) => stringToCharArray(r));
	tileSymbols[position[1]][position[0]] = symbol;
	return {
		...map,
		mapTiles: tileSymbols.map((r) => r.join("")).join("\n"),
	};
}
