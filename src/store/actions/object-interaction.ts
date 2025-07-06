import { objectInteractGen } from "../../ai/object-interact-gen.js";
import { getTile } from "../../utils/get-tile.js";
import { type GameState, useGameStore } from "../game-store.js";
import {
	incrementMessageIndex,
	recordChoice,
} from "../utils/interaction-utils.js";
import { defineAction } from "./action.js";

export function getNearbyObject(state: GameState) {
	const {
		playerPosition: [x, y],
		map,
	} = state;
	const { objects, mapTiles } = map;

	// Check all 8 adjacent positions (including diagonals)
	const adjacentPositions: [number, number][] = [
		[x - 1, y - 1], // top-left
		[x, y - 1], // top
		[x + 1, y - 1], // top-right
		[x - 1, y], // left
		[x + 1, y], // right
		[x - 1, y + 1], // bottom-left
		[x, y + 1], // bottom
		[x + 1, y + 1], // bottom-right
	];

	for (const pos of adjacentPositions) {
		const symbol = getTile(mapTiles, pos);
		if (symbol && /[A-Z]/.test(symbol)) {
			const object = objects.find((obj) => obj.letter === symbol);
			if (object) {
				return object;
			}
		}
	}

	return null;
}

export const startOrContinueInteraction = defineAction(
	async (state: GameState) => {
		const nearbyObject = getNearbyObject(state);

		if (!nearbyObject) {
			return state;
		}

		let { interactionState } = state;

		if (!interactionState) {
			useGameStore.setState({
				interactionState: {
					currentMessageIndex: 0,
					currentObject: nearbyObject,
					chatMessages: [{ role: "user", content: "How do you respond?" }],
				},
			});
			await objectInteractGen();
			return {};
		}

		if (
			interactionState?.choices &&
			interactionState.currentChoiceIndex !== undefined
		) {
			useGameStore.setState((state) => recordChoice(state));
		}

		state = useGameStore.getState();
		interactionState = state.interactionState;
		const messageIdx = interactionState?.currentMessageIndex ?? 0;
		const messages = interactionState?.chatMessages ?? [];
		if (messageIdx >= messages.length - 1) {
			return await objectInteractGen();
		}

		return incrementMessageIndex(state);
	},
);

export const endInteraction = defineAction((state: GameState) => {
	return {
		interactionState: undefined,
	};
});

export const moveChoice = defineAction(
	(state: GameState, direction: "up" | "down") => {
		if (!state.interactionState) return state;
		const currentChoice = state.interactionState.currentChoiceIndex ?? 0;
		const newChoiceIndex =
			direction === "up"
				? Math.max(0, currentChoice - 1)
				: Math.min(
						(state.interactionState.choices?.length ?? 1) - 1,
						currentChoice + 1,
					);
		return {
			...state,
			interactionState: {
				...state.interactionState,
				currentChoiceIndex: newChoiceIndex,
			},
		};
	},
);
