import { Newline, Text } from "ink";
import { Fragment } from "react/jsx-runtime";
import tinycolor from "tinycolor2";
import { colorMap } from "../map/map.schema.js";
import { type GameState, useGameStore } from "../store/game-store.js";
import { getTile } from "../utils/get-tile.js";
import { MeasuringBox } from "./measuring-box.js";

// a good utf char for a player
const PLAYER_TILE = (
	<Text key="player" bold color="green">
		@
	</Text>
);

/**
 * Renders the map tiles and player with teh player roughly in the center based on the screen width and height
 * @param width
 * @param height
 */
export function renderScene(width: number, height: number, state: GameState) {
	const [x, y] = state.playerPosition;
	const {
		tileColors,
		mapTiles: rawTileSymbols,
		nonWalkableSymbols,
	} = state.map;
	const tileSymbols = rawTileSymbols.split("\n");
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
				const symbol = tileSymbols[mapY][mapX];
				const color = getTile(tileColors, [mapX, mapY]);
				const colorName = colorMap[color as keyof typeof colorMap];
				const isWalkable = !nonWalkableSymbols.includes(symbol);
				renderedMap[i][j] = (
					<Text
						key={`${mapY},${mapX}`}
						backgroundColor={
							symbol === " "
								? tinycolor(colorName).darken().toHexString()
								: undefined
						}
						color={colorName}
					>
						{symbol}
					</Text>
				);
			} else {
				renderedMap[i][j] = defaultTile;
			}
		}
	}

	renderedMap[halfHeight][halfWidth] = PLAYER_TILE;

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
	return (
		<MeasuringBox flexGrow={1} overflow="hidden">
			{({ width, height }) => (
				<Text>{renderScene(width - 1, height, state)}</Text>
			)}
		</MeasuringBox>
	);
}
