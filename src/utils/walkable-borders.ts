import type { GameMap } from "../map/map.schema.js";
import { getMapTile } from "./get-tile.js";
import { randomPick } from "./random-pick.js";

export function getTileColumnCells(layer: string, x: number) {
	const rows = layer.split("\n");
	return rows.map((row, i) => [x, i] as const);
}

export function getTileRowCells(layer: string, y: number) {
	const rows = layer.split("\n");
	return rows[y].split("").map((cell, i) => [i, y] as const);
}

function isWalkable(map: GameMap, cell: readonly [number, number]): boolean {
	const tile = getMapTile(map, cell);
	return tile.passable;
}

export function getWalkableRowCells(map: GameMap, row: number) {
	const walkableCells = getTileRowCells(map.mapTiles, row).filter((cell) =>
		isWalkable(map, cell),
	);
	return walkableCells;
}

export function getWalkableColumnCells(map: GameMap, column: number) {
	const walkableCells = getTileColumnCells(map.mapTiles, column).filter(
		(cell) => isWalkable(map, cell),
	);
	return walkableCells;
}

export function pickWalkableRowCell(map: GameMap, row: number) {
	const walkableCells = getWalkableRowCells(map, row);
	return randomPick(walkableCells);
}

export function pickWalkableColumnCell(map: GameMap, column: number) {
	const walkableCells = getWalkableColumnCells(map, column);
	return randomPick(walkableCells);
}
