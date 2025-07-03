import type { GenerationConfig } from "../../ai/generate-map.js";
import { log } from "../../utils/log.js";
import type { GameState } from "../game-store.js";
import { defineAction } from "./action.js";
import { getMap } from "./transition-map.js";

export const loadGame = defineAction(
	async (state: GameState, config: GenerationConfig) => {
		const map = await getMap(config);
		log(`Loading game with map ${map.name}`);
		return {
			map,
		};
	},
);
