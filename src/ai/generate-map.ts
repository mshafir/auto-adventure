import { google } from "@ai-sdk/google";
import { GoogleGenAI } from "@google/genai";
import { generateObject, generateText } from "ai";
import type z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { env } from "../env.js";
import {
	GameDescriptionSchema,
	type GameMap,
	GameMapSchema,
} from "../map/map.schema.js";
import type { GameState } from "../store/game-store.js";
import { log } from "../utils/log.js";

export interface GenerationConfig {
	name: string;
	description?: string;
	state?: GameState;
	stateFrom?: "north" | "south" | "east" | "west";
	world: string;
}

async function objectGen<T>(
	prompt: string,
	schema: z.ZodSchema<T>,
): Promise<T> {
	const result = await generateObject({
		model: google("gemini-2.5-flash-preview-04-17"),
		temperature: 1,
		prompt,
		schema,
	});
	log("Usage: ", result.usage);
	return result.object;
}

export async function generateMap(config: GenerationConfig) {
	let result: GameMap = {
		name: config.name,
		description: config.description ?? "",
		objects: [],
		borders: {
			...(config.stateFrom && config.state
				? {
						[config.stateFrom]: {
							targetName: config.state.map.name,
							targetDescription: config.state.map.description,
						},
					}
				: undefined),
		},
		createdAt: new Date().toISOString(),
		world: config.world,
		worldCoordinates: config.state?.worldCoordinates ?? [0, 0],
		mapTiles: "",
		tileColors: "",
		nonWalkableSymbols: [],
	};
	const descResponse = await objectGen(
		`Come up with a several sentence description of a map named ${config.name} for an RPG game. 
${result.description && result.description !== "" ? `You are provided a basic description of ${config.description}.` : ""}
Expand the description to 2-3 sentences, adding some extra details.
Also provide at least 1 and up to 4 border areas that name and describe the surrounding maps to the north, south, east, and west.
Also provide several objects that are in the scene to make it interesting.

${
	config.state && config.state.mapHistory.length > 0
		? `The full history of visited maps is ${config.state?.mapHistory.reverse().join(" => ")} so you can cater the theme appropriately.`
		: ""
}
`,
		GameDescriptionSchema,
	);
	result.description = descResponse.description;
	result.objects = descResponse.objects;
	result.borders = {
		...descResponse.borders,
		...result.borders,
	};

	// raw google api
	// const genai = new GoogleGenAI({ apiKey: env.googleApiKey });
	// const response = await genai.models.generateContent({
	// 	model: "gemini-2.0-flash",
	// 	contents: Prompt(config),
	// 	config: {
	// 		responseMimeType: "application/json",
	// 		responseJsonSchema: zodToJsonSchema(GameMapSchema, {
	// 			$refStrategy: "none",
	// 			removeAdditionalStrategy: "strict",
	// 		}),
	// 	},
	// });
	// const map = JSON.parse(response.text ?? "{}") as GameMap;
	// log(`Generated result for prompt`, response.usageMetadata);

	const prompt = `
You are a creative game designer for a terminal-based RPG game.

Design a top-down 2D map for the location ${config.name}: 
${config.description}

The map should be at least 40x20 tiles large.
Specify corresponding layers of base symbols to draw the map and colors to apply to the map. 
Each of those layers should be exactly the same size and they should correspond to each other.
${
	config.state && config.state?.map.name !== ""
		? `The player just came from the map ${config.state.map.name} to the ${config.stateFrom}: 
${config.state.map.mapTiles}
`
		: ""
}

The map contains the following objects/NPCs:
${result.objects.map((o) => `${o.letter}: ${o.name} - ${o.description}`).join("\n")}

The map has the following surrounding areas:
${Object.entries(result.borders ?? {})
	.map(
		([direction, border]) =>
			`${direction}: ${border.targetName} - ${border.targetDescription}`,
	)
	.join("\n")}


Make sure to follow all of these rules strictly:
- Make sure to include all of letters of objects in the tile symbols exactly once.
- Make sure the tiles allow the user to reach the surrounding areas by clearing a path in the relevant direction.
- If there is no border in a certain direction, generate a non-walkable wall along that edge.
- For any specified border, make sure it is reachable and not blocked by a wall of non-walkable tiles.
- Be sure to include a few objects in the tile symbols so we can keep the game going. At least 1 object is required.
- Make sure the character can move around and all the specified borders are reachable.
- Make the maps interesting, with obstacles and different colors and ornate details, don't make them monotonous.

Check to make sure you have followed the above rules.
`;
	log(`Prompt: ${prompt}`);
	const response = await objectGen(prompt, GameMapSchema);
	result = {
		...result,
		...response,
	};

	return cleanupMap(result);
}

function cleanupMap(map: GameMap): GameMap {
	const currentRows = map.mapTiles.split("\n");
	const currentColorRows = map.tileColors.split("\n");
	const longestWidth = Math.max(...currentRows.map((s) => s.length));
	const rows = [];
	const colorRows = [];
	for (const [i, row] of currentRows.entries()) {
		rows.push(row.padEnd(longestWidth, row.slice(-1)[0]));
		colorRows.push(
			currentColorRows[i].padEnd(
				longestWidth,
				currentColorRows[i].slice(-1)[0],
			),
		);
	}
	return {
		...map,
		mapTiles: rows.join("\n"),
		tileColors: colorRows.join("\n"),
	};
}
