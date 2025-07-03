import { Box, Text } from "ink";
import { getNearbyObject } from "../store/actions/object-interaction.js";
import { useGameStore } from "../store/game-store.js";

export function MessagePanel() {
	const state = useGameStore();
	return (
		<Box
			borderStyle={"single"}
			height={6}
			overflow="hidden"
			flexDirection="column"
		>
			<Box flexGrow={1} flexShrink={1}>
				{state.interactionState.isInteracting ? (
					<Text>
						{
							state.interactionState.chatMessages[
								state.interactionState.chatMessages.length - 1
							]
						}
					</Text>
				) : (
					<Text>{state.map.name}</Text>
				)}
			</Box>
			<Box>
				{state.interactionState.isInteracting ? (
					<Text>Press ESC to exit interaction</Text>
				) : getNearbyObject(state) ? (
					<Text>
						Press SPACE to interact with {getNearbyObject(state)?.name}
					</Text>
				) : (
					<Text>Use arrow keys to move</Text>
				)}
			</Box>
		</Box>
	);
}
