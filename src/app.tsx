import { Box, Text } from "ink";
import { useEffect } from "react";
import { FullscreenBox } from "./components/fullscreen-box.js";
import { GameMap } from "./components/game-map.js";
import { MessagePanel } from "./components/message-panel.js";
import { SidePanel } from "./components/side-panel.js";
import { env } from "./env.js";
import { useGameInput } from "./hooks/use-game-input.js";
import { loadGame } from "./store/actions/load-game.js";
import { invokeAction, useGameStore } from "./store/game-store.js";

export default function App() {
	return (
		<FullscreenBox>
			<LoadGame />
		</FullscreenBox>
	);
}

function LoadGame() {
	const state = useGameStore();
	const mapLoaded = state.map.name !== "";

	useEffect(() => {
		if (mapLoaded) return;
		invokeAction(loadGame, {
			world: env.worldName,
			name: "Home Village - Town Square",
		});
	}, [mapLoaded]);

	if (!mapLoaded) {
		return <Text>Loading map...</Text>;
	}

	return <Game />;
}

function Game() {
	const status = useGameInput();
	return (
		<Box flexDirection="row" flexGrow={1}>
			<Box flexDirection="column" flexGrow={1} flexShrink={1} flexWrap="nowrap">
				<GameMap />
				<MessagePanel />
			</Box>
			<SidePanel
				width={40}
				flexBasis={40}
				flexGrow={0}
				flexShrink={0}
				isProcessing={status}
			/>
		</Box>
	);
}
