import z from "zod";

export const SurroundingMapSchema = z.object({
	targetName: z.string().describe("The name of the map to the north"),
	targetDescription: z.string().describe("Description of the northern map"),
});

export const GameDescriptionSchema = z.object({
	description: z.string().describe(`A 2-3 sentence description of the setting`),
	objects: z.array(
		z.object({
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
Use a number 0-9 to indicate an interactive object or NPC on the map, otherwise use the letters in the specified tileset.`,
	),
	surroundingMaps: z
		.object({
			north: SurroundingMapSchema,
			south: SurroundingMapSchema,
			east: SurroundingMapSchema,
			west: SurroundingMapSchema,
		})
		.partial(),
});

export type GameMap = z.infer<typeof GameDescriptionSchema> &
	z.infer<typeof GameMapSchema> & {
		name: string;
		world: string;
		tileset: string;
		worldCoordinates: [number, number];
		createdAt: string;
	};
