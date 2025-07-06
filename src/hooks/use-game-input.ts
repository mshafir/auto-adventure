import { type Key, useInput } from "ink";
import { useState } from "react";
import type { Action } from "../store/actions/action.js";
import { movePlayer } from "../store/actions/move-player.js";
import {
	endInteraction,
	moveChoice,
	startOrContinueInteraction,
} from "../store/actions/object-interaction.js";
import { regenerateTiles } from "../store/actions/regenerate-tiles.js";
import {
	type GameState,
	invokeAction,
	useGameStore,
} from "../store/game-store.js";

type InputEvent<Args extends unknown[]> = {
	condition: (input: string, key: Key, state: GameState) => boolean;
	action: Action<Args>;
	args: (state: GameState, input: string, key: Key) => Args;
};

function event<Args extends unknown[]>(
	condition: (input: string, key: Key, state: GameState) => boolean,
	action: Action<Args>,
	args: Args | ((state: GameState, input: string, key: Key) => Args),
) {
	return {
		condition,
		action,
		args: typeof args === "function" ? args : () => args,
	};
}

const events: InputEvent<any[]>[] = [
	event(
		(input, key, state) => key.escape && !!state.interactionState,
		endInteraction,
		[],
	),
	event((input, key, state) => input === " ", startOrContinueInteraction, []),
	event(
		(input, key, state) => key.leftArrow && !state.interactionState,
		movePlayer,
		["left"],
	),
	event(
		(input, key, state) => key.rightArrow && !state.interactionState,
		movePlayer,
		["right"],
	),
	event(
		(input, key, state) => key.upArrow && !state.interactionState,
		movePlayer,
		["up"],
	),
	event(
		(input, key, state) => key.downArrow && !state.interactionState,
		movePlayer,
		["down"],
	),
	event((input, key, state) => key.ctrl && input === "r", regenerateTiles, []),
	event(
		(input, key, state) => key.upArrow && !!state.interactionState,
		moveChoice,
		["up"],
	),
	event(
		(input, key, state) => key.downArrow && !!state.interactionState,
		moveChoice,
		["down"],
	),
];

export function useGameInput() {
	const [isProcessing, setIsProcessing] = useState(false);
	const store = useGameStore();
	useInput(async (input, key) => {
		if (isProcessing) {
			return;
		}
		const timeout = setTimeout(() => setIsProcessing(true), 1000);
		for (const event of events) {
			if (event.condition(input, key, store)) {
				const args = event.args(store, input, key);
				await invokeAction(event.action, ...args);
				break;
			}
		}
		timeout.close();
		setIsProcessing(false);
	});

	return isProcessing;
}
