import { cleanupMap } from "../../ai/cleanup-map.js";
import { generateMapTiles } from "../../ai/generate-map.js";
import { saveMap } from "../../map/map-loading.js";
import type { GameState } from "../game-store.js";
import { defineAction } from "./action.js";
import { determineStartingPlayerPosition } from "./load-game.js";

export const regenerateTiles = defineAction(async (state: GameState) => {
	const newMap = cleanupMap(
		await generateMapTiles(
			{
				name: state.map.name,
				description: state.map.description,
				world: state.map.world,
				stateFrom: state.lastFrom,
				stateFromName: state.mapHistory[0],
				state: state,
			},
			state.map,
		),
	);
	saveMap(newMap);

	return {
		map: newMap,
		interactionState: undefined,
		playerPosition: determineStartingPlayerPosition(newMap),
	};
});
