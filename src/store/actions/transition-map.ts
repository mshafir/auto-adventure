import { type GenerationConfig, generateMap } from "../../ai/generate-map.js";
import type { GameMap } from "../../map/map.schema.js";
import { loadMap, mapExists, saveMap } from "../../map/map-loading.js";
import { getMapDimensions } from "../../utils/get-map-dimensions.js";
import { log } from "../../utils/log.js";
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
		const { borders } = state.map;
		const [currentX, currentY] = state.worldCoordinates;

		let borderInfo:
			| { targetName: string; targetDescription: string }
			| undefined;
		let newCoordinates: [number, number] | undefined;
		let stateFrom: "north" | "south" | "east" | "west" | undefined;

		switch (direction) {
			case "up":
				if (borders?.north) {
					borderInfo = borders.north;
					newCoordinates = [currentX, currentY - 1];
					stateFrom = "south";
				}
				break;
			case "down":
				if (borders?.south) {
					borderInfo = borders.south;
					newCoordinates = [currentX, currentY + 1];
					stateFrom = "north";
				}
				break;
			case "left":
				if (borders?.west) {
					borderInfo = borders.west;
					newCoordinates = [currentX - 1, currentY];
					stateFrom = "east";
				}
				break;
			case "right":
				if (borders?.east) {
					borderInfo = borders.east;
					newCoordinates = [currentX + 1, currentY];
					stateFrom = "west";
				}
				break;
		}

		if (!borderInfo || !newCoordinates) {
			return state;
		}

		log(
			`Crossing ${direction} border to ${borderInfo.targetName} from ${stateFrom}`,
		);
		const newMap = await getMap({
			world: state.world,
			name: borderInfo.targetName,
			description: borderInfo.targetDescription,
			state: {
				...state,
				worldCoordinates: newCoordinates,
			},
			stateFrom,
		});

		const { width, height } = getMapDimensions(newMap);

		let newPlayerPosition: [number, number];
		switch (direction) {
			case "up":
				newPlayerPosition = [Math.floor(width / 2), height - 2]; // Near bottom
				break;
			case "down":
				newPlayerPosition = [Math.floor(width / 2), 1]; // Near top
				break;
			case "left":
				newPlayerPosition = [width - 2, Math.floor(height / 2)]; // Near right
				break;
			case "right":
				newPlayerPosition = [1, Math.floor(height / 2)]; // Near left
				break;
		}

		return {
			map: newMap,
			mapHistory: [state.map.name, ...state.mapHistory],
			worldCoordinates: newCoordinates,
			playerPosition: newPlayerPosition,
		};
	},
);
