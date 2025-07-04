import { type GenerationConfig, generateMap } from "../../ai/generate-map.js";
import type { GameMap } from "../../map/map.schema.js";
import { loadMap, mapExists, saveMap } from "../../map/map-loading.js";
import { getMapDimensions } from "../../utils/get-map-dimensions.js";
import { log } from "../../utils/log.js";
import {
	pickWalkableColumnCell,
	pickWalkableRowCell,
} from "../../utils/walkable-borders.js";
import type { GameState } from "../game-store.js";
import { defineAction } from "./action.js";

export async function getMap(config: GenerationConfig): Promise<GameMap> {
	const { world, state } = config;
	const coords = state?.worldCoordinates ?? [0, 0];
	if (mapExists(world, coords)) {
		return loadMap(world, coords);
	}

	const map = await generateMap(config);
	saveMap(map);
	return map;
}

export const transitionMap = defineAction(
	async (state: GameState, direction: "up" | "down" | "left" | "right") => {
		const { surroundingMaps } = state.map;
		const [currentX, currentY] = state.worldCoordinates;

		let mapInfo: { targetName: string; targetDescription: string } | undefined;
		let newCoordinates: [number, number] | undefined;
		let stateFrom: "north" | "south" | "east" | "west" | undefined;

		switch (direction) {
			case "up":
				if (surroundingMaps?.north) {
					mapInfo = surroundingMaps.north;
					newCoordinates = [currentX, currentY - 1];
					stateFrom = "south";
				}
				break;
			case "down":
				if (surroundingMaps?.south) {
					mapInfo = surroundingMaps.south;
					newCoordinates = [currentX, currentY + 1];
					stateFrom = "north";
				}
				break;
			case "left":
				if (surroundingMaps?.west) {
					mapInfo = surroundingMaps.west;
					newCoordinates = [currentX - 1, currentY];
					stateFrom = "east";
				}
				break;
			case "right":
				if (surroundingMaps?.east) {
					mapInfo = surroundingMaps.east;
					newCoordinates = [currentX + 1, currentY];
					stateFrom = "west";
				}
				break;
		}

		if (!mapInfo || !newCoordinates) {
			return state;
		}

		log(
			`Crossing ${direction} border to ${mapInfo.targetName} from ${stateFrom}`,
		);
		const newMap = await getMap({
			world: state.world,
			name: mapInfo.targetName,
			description: mapInfo.targetDescription,
			state: {
				...state,
				worldCoordinates: newCoordinates,
			},
			stateFrom,
			stateFromName: state.map.name,
		});

		const { width, height } = getMapDimensions(newMap);
		let newPlayerPosition: readonly [number, number] | undefined;
		switch (direction) {
			case "up":
				newPlayerPosition = pickWalkableRowCell(newMap, height - 1); // Near bottom
				break;
			case "down":
				newPlayerPosition = pickWalkableRowCell(newMap, 0); // Near top
				break;
			case "left":
				newPlayerPosition = pickWalkableColumnCell(newMap, width - 1); // Near right
				break;
			case "right":
				newPlayerPosition = pickWalkableColumnCell(newMap, 0); // Near left
				break;
		}

		const historyIndex = state.mapHistory.indexOf(state.map.name);

		return {
			map: newMap,
			mapHistory: [state.map.name, ...state.mapHistory.slice(historyIndex + 1)],
			lastFrom: stateFrom,
			worldCoordinates: newCoordinates,
			playerPosition: newPlayerPosition ?? [10, 10],
		};
	},
);
