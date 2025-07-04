import z from "zod";
import { CONFIG } from "../env.js";

export const SurroundingMapSchema = z.object({
	targetName: z.string().describe("The name of the map to the north"),
	targetDescription: z.string().describe("Description of the northern map"),
});

export const GameDescriptionSchema = z.object({
	description: z.string().describe(`A 2-3 sentence description of the setting`),
	objects: z.array(
		z.object({
			letter: z
				.string()
				.describe(
					"The corresponding object in the mapTiles layer. This letter must appear somewhere in the mapTiles layer.",
				),
			name: z.string().describe("The name of the object."),
			description: z
				.string()
				.describe("A description of the object and how it should interact"),
		}),
	),
});

export const GameMapSchema = z.object({
	mapTiles: z.string().describe(
		`A grid of the map tiles to draw for the map. Use a newline to start a new row. 
You can use '${CONFIG.nonWalkableSymbols.join("', '")}' for the tiles that are non-walkable, along with any other monospace characters you think would be nice.
Use a capital letter A-Z to indicate an interactive object or NPC on the map, otherwise avoid using color letters or any other letters in the tile layer.`,
	),
	tileColors: z.string().describe(
		`A grid of the colors of the map corresponding to the mapTiles. 
This will set the foreground and background (foregrounds brighter) so make sure not to make a non-walkable block symbol confusable with an empty space symbol. 
Use a newline to start a new row. Use a space to indicate a default color tile. Use ${Object.entries(
			CONFIG.colorMap,
		)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")} for the colors.`,
	),
	surroundingMaps: z
		.object({
			north: SurroundingMapSchema.optional(),
			south: SurroundingMapSchema.optional(),
			east: SurroundingMapSchema.optional(),
			west: SurroundingMapSchema.optional(),
		})
		.optional(),
	nonWalkableSymbols: z
		.array(z.string())
		.describe(`A list of symbols that are non-walkable.`),
});

export type GameMap = z.infer<typeof GameDescriptionSchema> &
	z.infer<typeof GameMapSchema> & {
		name: string;
		world: string;
		worldCoordinates: [number, number];
		createdAt: string;
	};
