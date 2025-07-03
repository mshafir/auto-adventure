import { getMapDimensions } from "../../utils/get-map-dimensions.js";
import { getTile } from "../../utils/get-tile.js";
import type { GameState } from "../game-store.js";
import { defineAction } from "./action.js";
import { transitionMap } from "./transition-map.js";

const setPlayerPosition = defineAction(
	(state: GameState, position: [number, number]) => {
		const { mapTiles } = state.map;
		const symbol = getTile(mapTiles, position);

		if (symbol && state.map.nonWalkableSymbols.includes(symbol)) {
			return state;
		}

		return {
			playerPosition: position,
		};
	},
);

export const movePlayer = defineAction(
	async (state: GameState, direction: "up" | "down" | "left" | "right") => {
		const newPos = [...state.playerPosition] as [number, number];
		switch (direction) {
			case "up":
				newPos[1]--;
				break;
			case "down":
				newPos[1]++;
				break;
			case "left":
				newPos[0]--;
				break;
			case "right":
				newPos[0]++;
				break;
		}

		// Check if we're going out of bounds (border transition)
		const { width, height } = getMapDimensions(state.map);

		if (
			newPos[0] < 0 ||
			newPos[0] >= width ||
			newPos[1] < 0 ||
			newPos[1] >= height
		) {
			// Attempt border transition
			return await transitionMap(state, direction);
		}

		return setPlayerPosition(state, newPos);
	},
);
