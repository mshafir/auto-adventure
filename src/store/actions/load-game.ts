import { existsSync, readFileSync } from "node:fs";
import type { GenerationConfig } from "../../ai/generate-map.js";
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
			playerPosition: determineStartingPlayerPosition({
				...state,
				map,
			}),
		};
	},
);

export function determineStartingPlayerPosition(state: GameState) {
	const { width, height } = getMapDimensions(state.map);
	let playerPosition: readonly [number, number] | undefined;
	const direction =
		state.lastFrom ?? randomPick(Object.keys(state.map.surroundingMaps ?? {}));
	if (direction === "north") {
		playerPosition = pickWalkableRowCell(state.map, 0);
	} else if (direction === "south") {
		playerPosition = pickWalkableRowCell(state.map, height - 1);
	} else if (direction === "east") {
		playerPosition = pickWalkableColumnCell(state.map, width - 1);
	} else if (direction === "west") {
		playerPosition = pickWalkableColumnCell(state.map, 0);
	}
	return playerPosition ?? [10, 10];
}
