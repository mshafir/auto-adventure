import { create } from "zustand";
import { env } from "../env.js";
import type { GameMap } from "../map/map.schema.js";
import { loadMap } from "../map/map-loading.js";
import { log } from "../utils/log.js";
import type { Action } from "./actions/action.js";

export type GameState = {
	locked: boolean;
	map: GameMap;
	playerPosition: [number, number];
	mapHistory: string[];
	worldCoordinates: [number, number]; // [x, y] coordinates in the world
	world: string;
	interactionState: {
		isInteracting: boolean;
		currentObject: {
			name: string;
			description: string;
			letter: string;
		} | null;
		chatMessages: string[];
	};
};

const defaultMap: GameMap = {
	name: "",
	createdAt: new Date().toISOString(),
	description: "",
	mapTiles: "",
	tileColors: "",
	nonWalkableSymbols: [],
	objects: [],
	borders: {},
	world: env.worldName,
	worldCoordinates: [0, 0],
};

export const useGameStore = create<GameState>(() => ({
	locked: false,
	map: defaultMap,
	playerPosition: [10, 10],
	mapHistory: [],
	worldCoordinates: [0, 0],
	world: env.worldName,
	interactionState: {
		isInteracting: false,
		currentObject: null,
		chatMessages: [],
	},
}));

export async function invokeAction<Args extends any[]>(
	action: Action<Args>,
	...args: Args
) {
	const state = useGameStore.getState();
	if (state.locked) {
		log("Cannot perform state update, state is locked");
		return;
	}
	useGameStore.setState((state) => ({ ...state, locked: true }));
	try {
		const newState = await action(state, ...args);
		useGameStore.setState({
			...newState,
			locked: false,
		});
	} catch (e) {
		log(
			"Error during action:",
			e,
			e && typeof e === "object" && "message" in e ? e.message : undefined,
		);
		useGameStore.setState({
			locked: false,
		});
	}
}
