import { z } from "zod";
import type { StructureKind } from "../gen/features/patch.js";
import { authorableStructureKinds } from "../gen/features/structures.js";
import { TERRAIN, terrainByKey } from "../tiles/terrain.js";
import { ALL_BIOMES } from "./biome.js";
import { CHUNK, HALO } from "./coords.js";

/**
 * A recipe as it arrives from a file.
 *
 * A recipe is data from outside the program, and it reaches the deepest layer of the
 * generator — a bad number here does not throw, it produces a world. `seaLevel: 1.4`
 * is a drowned map with no error anywhere; `radius: 4000` is a town whose outskirts
 * silently vanish two chunks out, because the halo only looks so far. So every
 * numeric field is bounded to a range that still generates something playable, and
 * the bounds are the documentation.
 */

const unitRange = z.number().min(0).max(1);

/**
 * A terrain, written the way an author would write it.
 *
 * Accepts `"sand"` and normalises to the registry id, because a recipe is a file a
 * person edits and `{ ground: 23 }` is not a sentence anybody can check. The numeric
 * form is accepted too and has to be: the normalised value is what gets persisted
 * into the save, so this schema has to be able to read back what it wrote.
 */
const terrainId = z.union([
	z
		.string()
		.min(1)
		.transform((key, ctx) => {
			const def = terrainByKey(key);
			if (!def) {
				ctx.addIssue({ code: "custom", message: `no terrain called "${key}"` });
				return z.NEVER;
			}
			return def.id;
		}),
	z
		.number()
		.int()
		.min(1)
		.max(TERRAIN.length - 1),
]);

export const ClimateRecipeSchema = z
	.object({
		seaLevel: unitRange.optional(),
		shoreLevel: unitRange.optional(),
		uplandLevel: unitRange.optional(),
		alpineLevel: unitRange.optional(),
		elevationBias: z.number().min(-0.5).max(0.5).optional(),
		// Below ~40 the continents break into noise; above ~2000 the whole world is one
		// biome, which is a legitimate thing to want and the reason the ceiling is high.
		elevationScale: z.number().min(40).max(4000).optional(),
		moistureBias: z.number().min(-1).max(1).optional(),
		moistureScale: z.number().min(20).max(4000).optional(),
		temperatureBias: z.number().min(-1).max(1).optional(),
		temperatureScale: z.number().min(20).max(4000).optional(),
		latitudeBand: z.number().min(256).max(1_000_000).optional(),
		roughnessScale: z.number().min(4).max(1000).optional(),
	})
	.strict()
	.refine(
		(climate) =>
			ordered(climate.seaLevel, climate.shoreLevel, climate.uplandLevel, climate.alpineLevel),
		{
			message: "elevation bands must ascend: seaLevel < shoreLevel < uplandLevel < alpineLevel",
		},
	);

/**
 * Bands must ascend, and a partial override still has to ascend against the defaults.
 *
 * Raising `seaLevel` past `shoreLevel` without touching `shoreLevel` makes the shore
 * band empty, so every coast in the world becomes lowland grass running into deep
 * water with no beach — which reads as a rendering bug rather than as a setting.
 */
function ordered(...levels: (number | undefined)[]): boolean {
	const defaults = [0.42, 0.46, 0.66, 0.8];
	const resolved = levels.map((level, i) => level ?? (defaults[i] as number));
	return resolved.every((level, i) => i === 0 || level > (resolved[i - 1] as number));
}

export const BiomeOverrideSchema = z
	.object({
		name: z.string().min(1).max(40).optional(),
		ground: terrainId.optional(),
		groundAlt: terrainId.optional(),
		scatterDensity: unitRange.optional(),
		scatter: z
			.array(z.tuple([terrainId, z.number().min(0).max(100)]))
			.max(12)
			.optional(),
		habitable: z.boolean().optional(),
	})
	.strict();

const SETTLED_KINDS = [
	"hamlet",
	"village",
	"town",
	"fort",
	"camp",
	"ruins",
	"landmark",
	"cave",
	"castle",
	"docks",
] as const;

const settledKind = z.enum(SETTLED_KINDS);

/**
 * Per-kind percentages of habitable cells.
 *
 * Capped at 40% each and 80% in total. A world where four cells in five hold a town
 * is not a denser world, it is one continuous suburb: settlement footprints overlap,
 * the clip-into-chunks model handles it but every place runs into the next, and the
 * road MST degenerates into a mesh.
 */
// `partialRecord`, not `record`: a `z.record` over an enum in zod 4 demands *every*
// key, so `{ "town": 0.5 }` came back as nine errors complaining that the other nine
// biomes were undefined. Every table here is an override table and every key is
// optional by definition.
const weightTable = z.partialRecord(settledKind, z.number().min(0).max(40));

/**
 * Buildings a roster may ask for, from the structure registry.
 *
 * The registry rather than a list written here, for the reason `STRUCTURE_KINDS` is
 * derived: a second copy of the kinds is a copy that can be wrong, and the symptom is a
 * recipe that validates and then asks for a building with no plan behind it.
 */
const structureKind = z.enum(authorableStructureKinds() as [StructureKind, ...StructureKind[]]);

/** Weighted `[kind, weight]` pairs, as both the roster and the filler are written. */
const structureTable = z
	.array(z.tuple([structureKind, z.number().min(0).max(100)]))
	.min(1)
	.max(24);

const RosterRuleSchema = z
	.object({
		count: z
			.object({
				// Forty is far past what any footprint holds — the surplus specs are dropped
				// when plots are assigned — so this is a guard against a typo costing a
				// minute of generation, not a design limit.
				base: z.number().int().min(0).max(40),
				perImportance: z.number().min(0).max(8).optional(),
			})
			.strict(),
		walled: z.union([z.boolean(), z.number().int().min(1).max(5)]).optional(),
		structures: structureTable,
	})
	.strict();

export const SiteRecipeSchema = z
	.object({
		weights: weightTable.optional(),
		wildWeights: weightTable.optional(),
		roster: z.partialRecord(settledKind, RosterRuleSchema).optional(),
		filler: structureTable.optional(),
		roads: z
			.object({ major: terrainId.optional(), minor: terrainId.optional() })
			.strict()
			.optional(),
		radius: z
			.partialRecord(
				settledKind,
				z
					.object({
						// 64 is one macro cell; a base beyond that guarantees neighbours overlap.
						base: z.number().int().min(2).max(64),
						perImportance: z.number().min(0).max(12).optional(),
					})
					.strict(),
			)
			.optional(),
		maxImportance: z.number().int().min(1).max(5).optional(),
		civilizationFloor: unitRange.optional(),
		maxSlope: z.number().min(0).max(1).optional(),
	})
	.strict()
	.refine((sites) => total(sites.weights) <= 80 && total(sites.wildWeights) <= 80, {
		message: "site weights must total 80% or less, or the map is one continuous town",
	});

function total(weights: Partial<Record<string, number>> | undefined): number {
	let sum = 0;
	for (const value of Object.values(weights ?? {})) sum += value ?? 0;
	return sum;
}

export const PlaceRecipeSchema = z
	.object({
		at: z.object({ x: z.number().int(), y: z.number().int() }),
		kind: settledKind,
		importance: z.number().int().min(1).max(5).optional(),
		// Bounded by what the halo can see, derived rather than written down: a place
		// wider than the halo would exist in the chunks near it and not in the chunks
		// beyond, which is the one failure the seam contract cannot absorb. `validate.ts`
		// checks the same limit against the resolved rules, for the paths that do not
		// come through this schema.
		radius: z
			.number()
			.int()
			.min(2)
			.max(HALO * CHUNK)
			.optional(),
	})
	.strict();

export const ZoneRecipeSchema = z
	.object({
		id: z.string().min(1).max(48).optional(),
		at: z.object({ x: z.number().int(), y: z.number().int() }),
		radius: z.number().min(4).max(4000),
		falloff: z.number().min(0.2).max(8).optional(),
		moisture: z.number().min(-1).max(1).optional(),
		temperature: z.number().min(-1).max(1).optional(),
		// Half the field either way. The whole span from sea floor to alpine is one unit, so
		// anything larger is not a valley or a hill but a world with a hole punched in it.
		elevation: z.number().min(-0.5).max(0.5).optional(),
		scatter: z.number().min(0).max(8).optional(),
	})
	.strict();

export const BoundsRecipeSchema = z
	.object({
		style: z.enum(["ocean", "cliffs", "mountains"]),
	})
	.strict()
	.partial();

export const WorldRecipeSchema = z
	.object({
		bounds: BoundsRecipeSchema.optional(),
		climate: ClimateRecipeSchema.optional(),
		biomes: z
			.partialRecord(z.enum(ALL_BIOMES as [string, ...string[]]), BiomeOverrideSchema)
			.optional(),
		sites: SiteRecipeSchema.optional(),
		places: z.array(PlaceRecipeSchema).max(64).optional(),
		zones: z.array(ZoneRecipeSchema).max(64).optional(),
	})
	.strict();
