import { Box, type BoxProps, Text } from "ink";
import { useGameStore } from "../store/game-store.js";

export function SidePanel({
	isProcessing,
	...props
}: { isProcessing: boolean } & BoxProps) {
	const state = useGameStore();
	return (
		<Box
			flexDirection="column"
			overflow="hidden"
			borderStyle={"single"}
			{...props}
		>
			<Box flexDirection="column" flexGrow={1} overflow="hidden">
				<Text>{state.map.description}</Text>
			</Box>
			<Box flexDirection="column">
				{Object.entries(state.map.borders ?? {}).map(([direction, border]) => (
					<Text key={direction}>
						{direction}: {border.targetName}
					</Text>
				))}
				<Text> </Text>
			</Box>
			<Box>
				<Text>
					Position: {state.playerPosition[0]}, {state.playerPosition[1]}
				</Text>
			</Box>
			<Box>
				<Text>
					World Position: {state.worldCoordinates[0]},{" "}
					{state.worldCoordinates[1]}
				</Text>
			</Box>
			<Box>
				<Text>History: {state.mapHistory.join(", ")}</Text>
			</Box>
			{isProcessing && (
				<Box>
					<Text>Loading...</Text>
				</Box>
			)}
		</Box>
	);
}
