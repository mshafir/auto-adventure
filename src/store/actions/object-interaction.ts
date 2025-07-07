import { objectInteractGen } from "../../ai/object-interact-gen.js";
import { getMapTile, getTileSymbol } from "../../utils/get-tile.js";
import { setTileSymbol } from "../../utils/set-tile.js";
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
		[x, y - 1], // top
		[x - 1, y], // left
		[x + 1, y], // right
		[x, y + 1], // bottom
	];

	for (const pos of adjacentPositions) {
		const symbol = getTileSymbol(mapTiles, pos);
		if (symbol && /[0-9]/.test(symbol)) {
			const object = objects
				.map((o, i) => ({ ...o, number: i }))
				.find((obj) => obj.number === Number(symbol));
			if (object) {
				return object;
			}
		}
	}

	return null;
}

function getFacingPosition(state: GameState): [number, number] {
	const { playerDirection } = state;
	const [x, y] = state.playerPosition;
	if (playerDirection === "up") {
		return [x, y - 1];
	}
	if (playerDirection === "down") {
		return [x, y + 1];
	}
	if (playerDirection === "left") {
		return [x - 1, y];
	}
	return [x + 1, y];
}

function getFacingTile(state: GameState) {
	const [x, y] = getFacingPosition(state);
	return getMapTile(state.map, [x, y]);
}

function getPlayerTile(state: GameState) {
	const [x, y] = state.playerPosition;
	return getMapTile(state.map, [x, y]);
}

export const startOrContinueInteraction = defineAction(
	async (state: GameState) => {
		const nearbyObject = getNearbyObject(state);

		if (!nearbyObject) {
			const facingTile = getFacingTile(state);
			if (!facingTile.passable) {
				const playerTile = getPlayerTile(state);
				return {
					map: setTileSymbol(
						state.map,
						getFacingPosition(state),
						playerTile.symbol,
					),
				};
			}
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

export const endInteraction = defineAction(() => {
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
