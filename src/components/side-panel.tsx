import { Box, type BoxProps, Text, useInput } from "ink";
import { useState } from "react";
import { useGameStore } from "../store/game-store.js";

export function SidePanel(props: BoxProps) {
	const state = useGameStore();
	const [tab, setTab] = useState("map");
	useInput((input) => {
		if (input === "i") {
			setTab("inventory");
		} else if (input === "q") {
			setTab("quests");
		} else if (input === "m") {
			setTab("map");
		}
	});
	return (
		<Box
			flexDirection="column"
			overflow="hidden"
			borderStyle={"single"}
			{...props}
		>
			<Box
				flexDirection="row"
				justifyContent="space-between"
				borderStyle={"single"}
				borderTop={false}
				borderLeft={false}
				borderRight={false}
			>
				<Text bold={tab === "map"}>(M)ap</Text>
				<Text bold={tab === "inventory"}>(I)nventory</Text>
				<Text bold={tab === "quests"}>(Q)uests</Text>
			</Box>
			{tab === "map" && (
				<>
					<Box flexDirection="column" flexGrow={1} overflow="hidden">
						<Text>{state.map.description}</Text>
					</Box>
					<Box flexDirection="column">
						{Object.entries(state.map.surroundingMaps ?? {}).map(
							([direction, map]) => (
								<Text key={direction}>
									{direction}: {map.targetName}
								</Text>
							)
						)}
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
				</>
			)}
			{tab === "inventory" &&
				state.inventory.map((item) => (
					<Box
						key={item.name}
						flexDirection="column"
						borderStyle="single"
						borderLeft={false}
						borderRight={false}
						borderTop={false}
					>
						<Text>
							{item.name} - {item.quantity}
						</Text>
						<Text color="gray">{item.description}</Text>
					</Box>
				))}
			{tab === "quests" &&
				state.quests.map((q) => (
					<Box
						key={q.name}
						borderStyle="single"
						flexDirection="column"
						borderLeft={false}
						borderRight={false}
						borderTop={false}
					>
						<Text color="magenta">
							{q.name}: {q.description}
						</Text>
						{q.completed ? (
							<Text color="green">Completed</Text>
						) : (
							<Text color="gray">{q.progress.join(", ")}</Text>
						)}
					</Box>
				))}
		</Box>
	);
}
