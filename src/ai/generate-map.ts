import z from "zod";
import {
	GameDescriptionSchema,
	type GameMap,
	SurroundingMapSchema,
} from "../map/map.schema.js";
import { TileSets } from "../map/tilesets/tilesets.js";
import { type GameState, useGameStore } from "../store/game-store.js";
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
		surroundingMaps: {},
		createdAt: new Date().toISOString(),
		world: config.world,
		worldCoordinates: config.state?.worldCoordinates ?? [0, 0],
		mapTiles: "",
		tileset: "basic",
	};
	useGameStore.setState({
		status: `Generating map details for ${config.name}...`,
	});
	const surroundingDirections = ["north", "south", "east", "west"].filter(
		(d) => d !== config.stateFrom,
	);
	const descResponse = await objectGen(
		`Come up with a several sentence description of a map named ${config.name} for an RPG game. 
${result.description && result.description !== "" ? `You are provided a basic description of ${config.description}.` : ""}
Expand the description to 2-3 sentences, adding some extra details and describing some structures that exist within the map of this location.
Also provide names and descriptions for the requested surrounding map areas to the north, south, east, and/or west.
Also provide several objects that are in the scene to make it interesting.

${
	config.stateFrom
		? `The player just came from the map ${config.stateFromName} to the ${config.stateFrom} so do not repeat this location`
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
		...(config.stateFrom && config.state && config.stateFromName
			? {
					[config.stateFrom]: {
						targetName: config.stateFromName,
						targetDescription: "",
					},
				}
			: undefined),
	};

	result = await generateMapTiles(config, result);

	return cleanupMap(result);
}

// The map contains the following objects/NPCs:
// ${result.objects.map((o) => `${o.letter}: ${o.name} - ${o.description}`).join("\n")}

export async function generateMapTiles(config: GenerationConfig, map: GameMap) {
	const result = { ...map };
	useGameStore.setState({
		status: `Generating map tiles for ${map.name}...`,
	});

	const prompt = `
You are a creative game designer for a terminal-based RPG game.

Design a top-down 2D map for the location ${map.name}: 
${map.description}

The map should be at least 40x20 tiles large and no more than 80x80 tiles.

The map has the following surrounding other map areas:
${Object.entries(result.surroundingMaps ?? {})
	.map(
		([direction, map]) =>
			`${direction}: ${map.targetName} - ${map.targetDescription}`,
	)
	.join("\n")}

Use the following tileset:
${Object.entries(TileSets[map.tileset as keyof typeof TileSets])
	.map(
		([k, v]) =>
			`${k} = ${v.description} (${v.passable ? "passable" : "non-passable"})`,
	)
	.join("\n")}

The map must contain the following objects/NPCs:
${result.objects.map((o, i) => `${i}: ${o.name} - ${o.description}`).join("\n")} 

Make sure to follow all of these rules strictly:
- Make sure to include only the letter and number symbols from the tileset and object list above.
- Include each of the object numbers ${result.objects.map((o, i) => i).join(", ")} somewhere in the map.
- Make sure the tiles allow the user to reach the specified surrounding areas in each direction.
  There should NOT be a non-passable wall along any edge of the map, use passable tiles and create a gap so the user
	can walk past the boundaries of the map to get to the next area in each of those directions.
- Make sure the character can move around and reach all the specified objects.
- Make the maps interesting, with obstacles and ornate details, don't make them monotonous. Don't repeat the same line more than a 2-3 times in a row.
- Avoid writing text directly into the map.

Check to make sure you have followed the above rules and return only the exact map, no explanation or other text.
`;
	const mapTiles = await textGen(prompt);

	// get the text between the ``` and ```
	result.mapTiles = extractMap(mapTiles);

	return result;
}

function extractMap(result: string) {
	return result.includes("```") ? result.split("```")[1] : result;
}
