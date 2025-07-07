import { writeFileSync } from "node:fs";
import { create } from "zustand";
import { ENV } from "../env.js";
import type { GameMap } from "../map/map.schema.js";
import { log } from "../utils/log.js";
import type { Action } from "./actions/action.js";

export type Quest = {
	name: string;
	description: string;
	progress: string[];
	completed: boolean;
};

export type InventoryItem = {
	name: string;
	description: string;
	quantity: number;
};

export type InteractionState = {
	currentObject?: {
		name: string;
		description: string;
		number: number;
	};
	currentMessageIndex?: number;
	currentChoiceIndex?: number;
	chatMessages?: { role: "user" | "assistant"; content: string }[];
	choices?: string[];
};

export type GameState = {
	locked: boolean;
	status?: string;
	map: GameMap;
	playerPosition: readonly [number, number];
	playerDirection: "up" | "down" | "left" | "right";
	mapHistory: string[];
	lastFrom?: "north" | "south" | "east" | "west";
	worldCoordinates: [number, number]; // [x, y] coordinates in the world
	world: string;
	inventory: InventoryItem[];
	quests: Quest[];
	interactionState?: InteractionState;
};

const defaultMap: GameMap = {
	name: "",
	createdAt: new Date().toISOString(),
	description: "",
	mapTiles: "",
	objects: [],
	surroundingMaps: {},
	world: ENV.worldName,
	worldCoordinates: [0, 0],
	tileset: "basic",
};

export const useGameStore = create<GameState>(() => ({
	locked: false,
	map: defaultMap,
	playerPosition: [10, 10],
	playerDirection: "up",
	mapHistory: [],
	worldCoordinates: [0, 0],
	world: ENV.worldName,
	inventory: [
		{
			name: "Gold",
			description: "A shiny coin",
			quantity: 10,
		},
	],
	quests: [],
	interactionState: undefined,
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
			status: undefined,
			locked: false,
		});
		writeFileSync(
			"state.json",
			JSON.stringify(useGameStore.getState(), null, 2),
		);
	} catch (e) {
		const errorMsg = `Error during action: ${e && typeof e === "object" && "message" in e ? e.message : JSON.stringify(e)}`;
		log(errorMsg);
		useGameStore.setState({
			status: errorMsg,
			locked: false,
		});
	}
}
