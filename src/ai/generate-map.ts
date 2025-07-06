import z from "zod";
import { CONFIG } from "../env.js";
import {
	GameDescriptionSchema,
	type GameMap,
	SurroundingMapSchema,
} from "../map/map.schema.js";
import { type GameState, useGameStore } from "../store/game-store.js";
import { sample } from "../utils/sample.js";
import { shuffle } from "../utils/shuffle.js";
import { cleanupMap } from "./cleanup-map.js";
import { objectGen } from "./object-gen.js";
import { textGen } from "./text-gen.js";

export interface GenerationConfig {
	name: string;
	description?: string;
	state?: GameState;
	stateFrom?: "north" | "south" | "east" | "west";
	stateFromName?: string;
	world: string;
}

const goodExample = `
  ┏━━━━━━━━━━━━━━━━━   ━━━━━━━━━━━━━━━━━━━┓┓┓┓┓┓┓┓┓┓┓┓┓┓┓┓┓┓
  ┃                                       ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃     ┏━━━━━━━┓     ┏━━━━━━━┓           ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃     ┃███████┃     ┃███████┃ N         ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃     ┃███████┃     ┃███████┃           ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃     ┗━━━━━━━┛     ┗━━━━━━━┛           ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ ##################################### ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ #                 ●                 # ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ #             ┏━●━┓             ●   # ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ #             ┃ F ┃                 # ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ #             ┗━●━┛             ●   # ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ #                 ●                 # ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃ ##################################### ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃   ┏━━━━━━━━━━━━━━━┓                   ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
   M █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ ┃                   ┃
  ┃   ┗━━━━━━━━━━━━━━━┛                   ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃                                       ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃                                       ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┃                                       ┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃┃
  ┗━━━━━━━━━━━━━━━━━   ━━━━━━━━━━━━━━━━━━━┛┛┛┛┛┛┛┛┛┛┛┛┛┛┛┛┛┛

which has surrounding areas to the north, west, and south and objects M, F, and N.
`;

export async function generateMap(config: GenerationConfig) {
	let result: GameMap = {
		name: config.name,
		description: config.description ?? "",
		objects: [],
		surroundingMaps: {
			...(config.stateFrom && config.state
				? {
						[config.stateFrom]: {
							targetName: config.stateFromName,
							targetDescription: "",
						},
					}
				: undefined),
		},
		createdAt: new Date().toISOString(),
		world: config.world,
		worldCoordinates: config.state?.worldCoordinates ?? [0, 0],
		mapTiles: "",
		tileColors: "",
		nonWalkableSymbols: CONFIG.nonWalkableSymbols,
	};
	useGameStore.setState({
		status: `Generating map details for ${config.name}...`,
	});
	const surroundingDirections = pickSurroundingDirections().filter(
		(d) => d !== config.stateFrom,
	);
	const descResponse = await objectGen(
		`Come up with a several sentence description of a map named ${config.name} for an RPG game. 
${result.description && result.description !== "" ? `You are provided a basic description of ${config.description}.` : ""}
Expand the description to 2-3 sentences, adding some extra details.
Also provide names and descriptions for the requested surrounding map areas to the north, south, east, and/or west.
Also provide several objects that are in the scene to make it interesting.

${
	config.stateFrom
		? `The player just came from the map ${config.stateFromName} to the ${config.stateFrom} so do not repeate this location`
		: ""
}

The player has the following items in their inventory: ${JSON.stringify(config.state?.inventory)}.
The player has the following active quests: ${JSON.stringify((config.state?.quests ?? []).filter((q) => !q.completed))}.

${
	config.state && config.state.mapHistory.length > 0
		? `The full history of visited maps is ${config.state?.mapHistory.reverse().join(" => ")} so you can cater the theme appropriately and avoid repeating these.`
		: ""
}
`,
		GameDescriptionSchema.extend({
			surroundingMaps: z.object({
				...Object.fromEntries(
					surroundingDirections
						.filter((d) => d !== config.stateFrom)
						.map((d) => [d, SurroundingMapSchema]),
				),
			}),
		}),
	);
	result.description = descResponse.description;
	result.objects = descResponse.objects;
	result.surroundingMaps = {
		...descResponse.surroundingMaps,
		...result.surroundingMaps,
	};

	result = await generateMapTiles(config, result);

	return cleanupMap(result);
}

export async function generateMapTiles(config: GenerationConfig, map: GameMap) {
	const result = { ...map };
	useGameStore.setState({
		status: `Generating map tiles for ${map.name}...`,
	});

	const prompt = `
You are a creative game designer for a terminal-based RPG game.

Design a top-down 2D map for the location ${map.name}: 
${map.description}

Here is a good example of a map for a Village Town Square location:
${goodExample}

The map should be at least 40x20 tiles large and no more than 100x100 tiles.

${
	config.state && config.state?.map.name !== "" && config.stateFrom
		? `The player just came from the map ${config.state.map.name} to the ${config.stateFrom}: 
${config.state.map.mapTiles}
`
		: ""
}

The map contains the following objects/NPCs:
${result.objects.map((o) => `${o.letter}: ${o.name} - ${o.description}`).join("\n")}

The map has the following surrounding other map areas:
${Object.entries(result.surroundingMaps ?? {})
	.map(
		([direction, map]) =>
			`${direction}: ${map.targetName} - ${map.targetDescription}`,
	)
	.join("\n")}

Use ${result.nonWalkableSymbols.join(", ")} as non-walkable, non-passable barrier tiles.

Make sure to follow all of these rules strictly:
- Make sure to include all of letters of objects in the tile symbols exactly once.
- Make sure the tiles allow the user to reach the specified surrounding areas by clearing a path in the relevant direction.
  There should NOT be a non-walkable wall along any surrounding map direction specified above, use walkable tiles and create a gap so the use
	can walk past the boundaries of the map to get to the next area in each of those directions.
- Make sure the character can move around and all the specified surrounding maps are reachable.
- Make the maps interesting, with obstacles and ornate details, don't make them monotonous.
- Avoid writing text directly into the map.

Check to make sure you have followed the above rules and return only the exact map, no explanation or other text.
`;
	const mapTiles = await textGen(prompt);

	// get the text between the ``` and ```
	result.mapTiles = extractMap(mapTiles);

	// base tile Colors
	result.tileColors = Array(result.mapTiles.length).fill(" ").join("\n");

	useGameStore.setState({
		status: `Generating map colors for ${config.name}...`,
	});

	const colorTileRaw = await textGen(`
You are a creative game designer for a terminal-based RPG game.
You have just designed the following map for the location ${config.name}: 
${result.mapTiles}

Provide a layer of colors for this map. The layer should be the exact same size.
Use ${Object.entries(CONFIG.colorMap)
		.map(([k, v]) => `${k}=${v}`)
		.join(
			", ",
		)} for the colors along with space for any tile that should be default, uncolored.

Check to make sure you have followed the above rules and return only the exact color map, no explanation or other text.
`);

	result.tileColors = extractMap(colorTileRaw);

	return result;
}

type Direction = "north" | "south" | "east" | "west";

const surroundingWeights = [
	[1, 2],
	[2, 5],
	[3, 10],
	[4, 5],
] as [number, number][];

/**
 * Randomly pick at least one, but up to 4 directions to generate
 */
function pickSurroundingDirections(): Direction[] {
	const directions = shuffle(["north", "south", "east", "west"] as const);
	const count = sample(surroundingWeights);
	return directions.slice(0, count);
}

function extractMap(result: string) {
	return result.includes("```") ? result.split("```")[1] : result;
}
