import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { cleanupMap } from "../ai/cleanup-map.js";
import type { GameMap } from "./map.schema.js";

export function mapExists(world: string, coords: [number, number]) {
	const mapFile = `maps/${world}/${coords[0]}-${coords[1]}.yaml`;
	return existsSync(mapFile);
}

export function loadMap(world: string, coords: [number, number]) {
	const mapFile = `maps/${world}/${coords[0]}-${coords[1]}.yaml`;
	const map = parse(readFileSync(mapFile, "utf-8")) as GameMap;
	return cleanupMap(map);
}

export function saveMap(map: GameMap) {
	const mapFile = `maps/${map.world}/${map.worldCoordinates[0]}-${map.worldCoordinates[1]}.yaml`;
	mkdirSync(`maps/${map.world}`, { recursive: true });
	writeFileSync(mapFile, stringify(map, {}));
}
