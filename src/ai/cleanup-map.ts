import type { GameMap } from "../map/map.schema.js";
import { stringToCharArray } from "../utils/find-tile.js";
import { getMapDimensions } from "../utils/get-map-dimensions.js";
import { removeAtIndicies } from "../utils/remove.js";
import {
	getTileColumnCells,
	getTileRowCells,
	getWalkableColumnCells,
	getWalkableRowCells,
} from "../utils/walkable-borders.js";

export function cleanupMap(map: GameMap): GameMap {
	let result = map;
	result = padMap(result);
	result = removeBlankRows(result);
	result = removeBlankColumns(result);
	result = openBorders(result);
	return result;
}

function padMap(map: GameMap): GameMap {
	const currentRows = map.mapTiles.split("\n");
	const longestWidth = Math.max(...currentRows.map((s) => s.length));
	const rows = [];
	for (const [i, row] of currentRows.entries()) {
		rows.push(row.padEnd(longestWidth, row.slice(-1)[0] ?? " "));
	}
	return {
		...map,
		mapTiles: rows.join("\n"),
	};
}

function removeBlankRows(map: GameMap): GameMap {
	const rows = map.mapTiles.split("\n");
	const emptyRows = rows
		.map((r, i) => [r, i] as const)
		.filter(([row, i]) => row.trim() === "")
		.map(([_, i]) => i);

	return {
		...map,
		mapTiles: removeAtIndicies(rows, emptyRows).join("\n"),
	};
}

function getCells(tiles: string) {
	return tiles.split("\n").map((row) => stringToCharArray(row));
}

function cellsToString(cells: string[][]) {
	return cells.map((row) => row.join("")).join("\n");
}

function removeBlankColumns(map: GameMap): GameMap {
	const cells = getCells(map.mapTiles);
	const { width, height } = getMapDimensions(map);
	const columns = Array.from({ length: width }, (_, i) => i);
	const emptyColumns = columns.filter((i) =>
		cells.every((row) => row[i] === " "),
	);
	const newCells = cells.map((row) => removeAtIndicies(row, emptyColumns));
	return {
		...map,
		mapTiles: cellsToString(newCells),
	};
}

function openBorders(map: GameMap) {
	let result = map;
	const { width, height } = getMapDimensions(result);
	if (map.surroundingMaps?.north) {
		const walkableCells = getWalkableRowCells(result, 0);
		if (walkableCells.length === 0) {
			result = randomOpen(result, getTileRowCells(result.mapTiles, 0));
		}
	}
	if (map.surroundingMaps?.south) {
		const walkableCells = getWalkableRowCells(map, height - 1);
		if (walkableCells.length === 0) {
			result = randomOpen(result, getTileRowCells(result.mapTiles, height - 1));
		}
	}
	if (map.surroundingMaps?.east) {
		let hasWalkableCells = false;
		let offset = 1;
		while (!hasWalkableCells) {
			const walkableCells = getWalkableColumnCells(result, width - offset);
			if (walkableCells.length < 4) {
				result = randomOpen(
					result,
					getTileColumnCells(result.mapTiles, width - offset),
				);
				offset = offset + 1;
			} else {
				hasWalkableCells = true;
			}
		}
	}
	if (map.surroundingMaps?.west) {
		const walkableCells = getWalkableColumnCells(result, 0);
		if (walkableCells.length === 0) {
			result = randomOpen(result, getTileColumnCells(result.mapTiles, 0));
		}
	}
	return result;
}

function randomOpen(map: GameMap, cells: (readonly [number, number])[]) {
	// const toOpen = randomPickMultiple(cells, 3);
	return openCells(map, cells);
}

function openCells(
	map: GameMap,
	cells: (readonly [number, number])[],
): GameMap {
	const rows = map.mapTiles.split("\n").map((row) => stringToCharArray(row));
	for (const cell of cells) {
		rows[cell[1]][cell[0]] = " ";
	}
	return {
		...map,
		mapTiles: rows.map((row) => row.join("")).join("\n"),
	};
}
