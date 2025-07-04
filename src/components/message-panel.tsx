import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { getNearbyObject } from "../store/actions/object-interaction.js";
import { useGameStore } from "../store/game-store.js";

export function MessageContents() {
	const state = useGameStore();

	const result = [];

	useInput((input, key) => {
		if (key.upArrow) {
			useGameStore.setState((state) => {
				if (!state.interactionState) return state;
				const currentChoice = state.interactionState.currentChoiceIndex ?? 0;
				return {
					...state,
					interactionState: {
						...state.interactionState,
						currentChoiceIndex: Math.max(0, currentChoice - 1),
					},
				};
			});
		} else if (key.downArrow) {
			useGameStore.setState((state) => {
				if (!state.interactionState) return state;
				const currentChoice = state.interactionState.currentChoiceIndex ?? 0;
				return {
					...state,
					interactionState: {
						...state.interactionState,
						currentChoiceIndex: Math.min(
							(state.interactionState.choices?.length ?? 1) - 1,
							currentChoice + 1
						),
					},
				};
			});
		}
	});

	if (state.interactionState) {
		const currentMessage =
			state.interactionState.chatMessages[
				state.interactionState.currentMessageIndex ?? 0
			];

		if (currentMessage) {
			result.push(
				<Text key={"message"} wrap="wrap">
					{currentMessage.role === "user" ? (
						<Spinner type="dots" />
					) : (
						currentMessage.content
					)}
				</Text>
			);
		}
		if (state.interactionState.choices) {
			for (const [idx, choice] of state.interactionState.choices.entries()) {
				result.push(
					<Text key={choice}>
						[{idx === state.interactionState.currentChoiceIndex ? ">" : " "}]{" "}
						{choice}
					</Text>
				);
			}
		}

		return <>{result}</>;
	}
	return <Text>{state.map.name}</Text>;
}

export function MessagePanel() {
	const state = useGameStore();
	return (
		<Box
			borderStyle={"single"}
			flexDirection="column"
			flexShrink={0}
			minHeight={5}
			justifyContent="space-between"
		>
			<MessageContents />
			{state.interactionState ? (
				<Text>Press ESC to exit interaction. Press SPACE to continue it.</Text>
			) : getNearbyObject(state) ? (
				<>
					<Text>
						{getNearbyObject(state)?.name}:{" "}
						{getNearbyObject(state)?.description}
					</Text>
					<Text>Press SPACE to interact.</Text>
				</>
			) : (
				<Text>Use arrow keys to move</Text>
			)}
		</Box>
	);
}
