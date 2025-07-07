import { Box, Newline, Text } from "ink";
import Spinner from "ink-spinner";
import { Fragment } from "react/jsx-runtime";
import { type GameState, useGameStore } from "../store/game-store.js";
import { getMapTile } from "../utils/get-tile.js";
import { MeasuringBox } from "./measuring-box.js";

/**
 * Renders the map tiles and player with the player roughly in the center based on the screen width and height
 * @param width
 * @param height
 */
export function renderScene(width: number, height: number, state: GameState) {
	const [x, y] = state.playerPosition;
	const { mapTiles } = state.map;
	const tileSymbols = mapTiles.split("\n");
	const defaultTile = <Text> </Text>; //state.map.defaultTile;

	const renderedMap = Array(height);
	const halfHeight = Math.floor(height / 2);
	const halfWidth = Math.floor(width / 2);

	const [mapStartX, mapStartY] = [x - halfWidth, y - halfHeight];

	for (let i = 0; i < height; i++) {
		renderedMap[i] = Array(width).fill(" ");
		for (let j = 0; j < width; j++) {
			const [mapY, mapX] = [mapStartY + i, mapStartX + j];
			if (
				mapY >= 0 &&
				mapY < tileSymbols.length &&
				mapX >= 0 &&
				mapX < tileSymbols[mapY].length
			) {
				const tile = getMapTile(state.map, [mapX, mapY]);
				renderedMap[i][j] = tile.render();
			} else {
				renderedMap[i][j] = defaultTile;
			}
		}
	}

	// player tile
	renderedMap[halfHeight][halfWidth] = (
		<Text key="player" bold color="green">
			{state.playerDirection === "up"
				? "▲"
				: state.playerDirection === "down"
				? "▼"
				: state.playerDirection === "left"
				? "◀"
				: "▶"}
		</Text>
	);

	return (
		<>
			{renderedMap.map((row, i) => (
				<Fragment
					key={`${
						// biome-ignore lint/suspicious/noArrayIndexKey: specific for index
						i
					}`}
				>
					{row}
					<Newline />
				</Fragment>
			))}
		</>
	);
}

export function GameMap() {
	const state = useGameStore();
	if (state.status) {
		return (
			<Box flexGrow={1} overflow="hidden">
				<Text>
					<Spinner type="material" /> {state.status}
				</Text>
			</Box>
		);
	}
	return (
		<MeasuringBox flexGrow={1} overflow="hidden">
			{({ width, height }) => (
				<Text>{renderScene(width - 1, height, state)}</Text>
			)}
		</MeasuringBox>
	);
}
