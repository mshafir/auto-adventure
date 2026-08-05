import { T, type TerrainId } from "../tiles/terrain.js";

/**
 * The biome table, on its own so a recipe can be resolved without loading the
 * generator.
 *
 * Split from `biome.ts` for one concrete reason: `resolveRecipe` merges overrides onto
 * this table at module-evaluation time, and `biome.ts` reaches `fields.ts`, which
 * reaches `recipe.ts` — a cycle whose only symptom was `DEFAULT_BIOME_TABLE` being
 * `undefined` in whichever module the loader happened to enter first. Data with no
 * dependencies belongs in a module with no dependencies.
 */

export type BiomeId =
	| "ocean"
	| "beach"
	| "marsh"
	| "grassland"
	| "meadow"
	| "shrubland"
	| "forest"
	| "rainforest"
	| "taiga"
	| "savanna"
	| "desert"
	| "badlands"
	| "moor"
	| "highland"
	| "alpine"
	| "glacier";

export interface BiomeDef {
	readonly id: BiomeId;
	readonly name: string;
	readonly ground: TerrainId;
	/** Secondary ground, blended in by the per-tile variant roll. */
	readonly groundAlt: TerrainId;
	/** Probability that a scatter cell in this biome places anything. */
	readonly scatterDensity: number;
	/** Weighted scatter table: `[terrain, weight]`. */
	readonly scatter: readonly (readonly [TerrainId, number])[];
	/** Whether settlements are permitted here at all. */
	readonly habitable: boolean;
}

/**
 * What each biome is, before a recipe has its say.
 *
 * Exported for `recipe.ts` to merge overrides onto. Nothing else should read it —
 * a caller that wants a biome's definition wants the *world's* definition, which is
 * {@link biomeDef}, and reading this directly is how a scenario's overrides get
 * quietly ignored in one place and honoured in another.
 */
export const DEFAULT_BIOME_TABLE: Record<BiomeId, BiomeDef> = {
	ocean: {
		id: "ocean",
		name: "open water",
		ground: T.deepWater,
		groundAlt: T.deepWater,
		scatterDensity: 0,
		scatter: [],
		habitable: false,
	},
	beach: {
		id: "beach",
		name: "shore",
		ground: T.sand,
		groundAlt: T.gravel,
		scatterDensity: 0.06,
		scatter: [[T.rock, 3]],
		habitable: true,
	},
	marsh: {
		id: "marsh",
		name: "marsh",
		ground: T.marsh,
		groundAlt: T.reeds,
		scatterDensity: 0.34,
		scatter: [
			[T.reeds, 6],
			[T.deadTree, 2],
			[T.bush, 1],
		],
		habitable: true,
	},
	grassland: {
		id: "grassland",
		name: "grassland",
		ground: T.grass,
		groundAlt: T.tallGrass,
		scatterDensity: 0.14,
		scatter: [
			[T.bush, 3],
			[T.broadleaf, 2],
			[T.flowers, 2],
			[T.rock, 1],
		],
		habitable: true,
	},
	meadow: {
		id: "meadow",
		name: "meadow",
		ground: T.grass,
		groundAlt: T.flowers,
		scatterDensity: 0.2,
		scatter: [
			[T.flowers, 6],
			[T.bush, 2],
			[T.broadleaf, 1],
		],
		habitable: true,
	},
	shrubland: {
		id: "shrubland",
		name: "scrub",
		ground: T.dirt,
		groundAlt: T.grass,
		scatterDensity: 0.24,
		scatter: [
			[T.bush, 6],
			[T.rock, 2],
			[T.deadTree, 1],
		],
		habitable: true,
	},
	forest: {
		id: "forest",
		name: "woodland",
		ground: T.forestFloor,
		groundAlt: T.grass,
		scatterDensity: 0.62,
		scatter: [
			[T.broadleaf, 8],
			[T.conifer, 2],
			[T.bush, 3],
			[T.stump, 1],
		],
		habitable: true,
	},
	rainforest: {
		id: "rainforest",
		name: "deep forest",
		ground: T.forestFloor,
		groundAlt: T.tallGrass,
		scatterDensity: 0.76,
		scatter: [
			[T.broadleaf, 10],
			[T.bush, 4],
			[T.tallGrass, 2],
		],
		habitable: true,
	},
	taiga: {
		id: "taiga",
		name: "pinewood",
		ground: T.forestFloor,
		groundAlt: T.snow,
		scatterDensity: 0.58,
		scatter: [
			[T.conifer, 10],
			[T.rock, 2],
			[T.deadTree, 1],
		],
		habitable: true,
	},
	savanna: {
		id: "savanna",
		name: "dry plain",
		ground: T.grass,
		groundAlt: T.dirt,
		scatterDensity: 0.1,
		scatter: [
			[T.broadleaf, 2],
			[T.bush, 3],
			[T.rock, 2],
		],
		habitable: true,
	},
	desert: {
		id: "desert",
		name: "desert",
		ground: T.sand,
		groundAlt: T.gravel,
		scatterDensity: 0.05,
		scatter: [
			[T.rock, 4],
			[T.deadTree, 1],
		],
		habitable: true,
	},
	badlands: {
		id: "badlands",
		name: "badlands",
		ground: T.gravel,
		groundAlt: T.dirt,
		scatterDensity: 0.18,
		scatter: [
			[T.rock, 8],
			[T.rubble, 3],
			[T.deadTree, 1],
		],
		habitable: false,
	},
	moor: {
		id: "moor",
		name: "moor",
		ground: T.tallGrass,
		groundAlt: T.marsh,
		scatterDensity: 0.16,
		scatter: [
			[T.bush, 4],
			[T.rock, 3],
			[T.deadTree, 2],
		],
		habitable: true,
	},
	highland: {
		id: "highland",
		name: "highland",
		ground: T.gravel,
		groundAlt: T.grass,
		scatterDensity: 0.22,
		scatter: [
			[T.rock, 7],
			[T.conifer, 3],
			[T.bush, 1],
		],
		habitable: true,
	},
	alpine: {
		id: "alpine",
		name: "high peaks",
		ground: T.snow,
		groundAlt: T.gravel,
		scatterDensity: 0.3,
		scatter: [
			[T.mountain, 8],
			[T.rock, 4],
		],
		habitable: false,
	},
	glacier: {
		id: "glacier",
		name: "icefield",
		ground: T.snow,
		groundAlt: T.ice,
		scatterDensity: 0.08,
		scatter: [[T.rock, 2]],
		habitable: false,
	},
};

export const ALL_BIOMES: readonly BiomeId[] = Object.keys(DEFAULT_BIOME_TABLE) as BiomeId[];
