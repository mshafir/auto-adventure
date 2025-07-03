import z from "zod";

export const colorMap = {
	x: "black",
	b: "blue",
	c: "cyan",
	g: "green",
	m: "magenta",
	r: "red",
	w: "white",
	y: "yellow",
};

const tileSymbols = [
	" ",
	"█",
	"▒",
	"░",
	"■",
	"━",
	"┃",
	"┏",
	"┓",
	"┗",
	"┛",
	"┣",
	"┫",
	"┳",
	"┻",
	"╋",
	"●",
	"╱",
	"╲",
	"~",
];

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
	borders: z
		.object({
			north: z
				.object({
					targetName: z.string().describe("The name of the map to the north"),
					targetDescription: z
						.string()
						.describe("Description of the northern map"),
				})
				.optional(),
			south: z
				.object({
					targetName: z.string().describe("The name of the map to the south"),
					targetDescription: z
						.string()
						.describe("Description of the southern map"),
				})
				.optional(),
			east: z
				.object({
					targetName: z.string().describe("The name of the map to the east"),
					targetDescription: z
						.string()
						.describe("Description of the eastern map"),
				})
				.optional(),
			west: z
				.object({
					targetName: z.string().describe("The name of the map to the west"),
					targetDescription: z
						.string()
						.describe("Description of the western map"),
				})
				.optional(),
		})
		.optional(),
});

export const GameMapSchema = z.object({
	mapTiles: z.string().describe(
		`A grid of the map tiles to draw for the map. Use a newline to start a new row. 
You can use '${tileSymbols.join("', '")}' for the tiles, along with any other monospace characters you think would be nice.
Use a capital letter A-Z to indicate an interactive object or NPC on the map, otherwise avoid using color letters or any other letters in the tile layer.`,
	),
	tileColors: z.string().describe(
		`A grid of the colors of the map corresponding to the mapTiles. 
This will set the foreground and background (foregrounds brighter) so make sure not to make a non-walkable block symbol confusable with an empty space symbol. 
Use a newline to start a new row. Use a space to indicate a default color tile. Use ${Object.entries(
			colorMap,
		)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")} for the colors.`,
	),
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
