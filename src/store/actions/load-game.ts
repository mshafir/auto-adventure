import { existsSync, readFileSync } from "node:fs";
import type { GenerationConfig } from "../../ai/generate-map.js";
import type { GameMap } from "../../map/map.schema.js";
import { getMapDimensions } from "../../utils/get-map-dimensions.js";
import { log } from "../../utils/log.js";
import { randomPick } from "../../utils/random-pick.js";
import {
	pickWalkableColumnCell,
	pickWalkableRowCell,
} from "../../utils/walkable-borders.js";
import type { GameState } from "../game-store.js";
import { defineAction } from "./action.js";
import { getMap } from "./transition-map.js";

export const loadGame = defineAction(
	async (state: GameState, config: GenerationConfig) => {
		if (existsSync("state.json")) {
			const state = JSON.parse(readFileSync("state.json", "utf8"));
			return state;
		}

		const map = await getMap(config);
		log(`Loading game with map ${map.name}`);

		return {
			map,
			playerPosition: determineStartingPlayerPosition(map),
		};
	},
);

export function determineStartingPlayerPosition(map: GameMap) {
	const { width, height } = getMapDimensions(map);
	let playerPosition: readonly [number, number] | undefined;
	const direction = randomPick(Object.keys(map.surroundingMaps ?? {}));
	if (direction === "north") {
		playerPosition = pickWalkableRowCell(map, 0);
	} else if (direction === "south") {
		playerPosition = pickWalkableRowCell(map, height - 1);
	} else if (direction === "east") {
		playerPosition = pickWalkableColumnCell(map, width - 1);
	} else if (direction === "west") {
		playerPosition = pickWalkableColumnCell(map, 0);
	}
	return playerPosition ?? [10, 10];
}
