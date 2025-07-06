import type { GameState } from "../game-store.js";

export function addMessage(
	state: Partial<GameState>,
	message: string,
): Partial<GameState> {
	if (!state.interactionState) return state;
	return {
		interactionState: {
			...state.interactionState,
			chatMessages: [
				...(state.interactionState?.chatMessages ?? []),
				{ role: "assistant", content: message },
			],
		},
	};
}

export function addUserMessage(
	state: Partial<GameState>,
	message: string,
): Partial<GameState> {
	if (!state.interactionState) return state;
	return {
		interactionState: {
			...state.interactionState,
			chatMessages: [
				...(state.interactionState?.chatMessages ?? []),
				{ role: "user", content: message },
			],
		},
	};
}

export function incrementMessageIndex(
	state: Partial<GameState>,
): Partial<GameState> {
	if (!state.interactionState) return state;
	return {
		interactionState: {
			...state.interactionState,
			currentMessageIndex: Math.min(
				(state.interactionState.chatMessages?.length ?? 0) - 1,
				(state.interactionState.currentMessageIndex ?? 0) + 1,
			),
		},
	};
}

export function recordChoice(state: GameState): Partial<GameState> {
	if (!state.interactionState) return state;
	const choice =
		state.interactionState.choices?.[
			state.interactionState.currentChoiceIndex ?? 0
		];
	if (!choice) return state;
	let result: Partial<GameState> = {
		interactionState: {
			...state.interactionState,
			choices: [],
			currentChoiceIndex: undefined,
		},
	};
	result = addUserMessage(result, choice);
	result = incrementMessageIndex(result);
	return result;
}
