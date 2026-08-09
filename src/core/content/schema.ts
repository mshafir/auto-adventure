import { z } from "zod";
import { WorldLoreSchema } from "../../ai/director/schemas.js";
import { WorldRecipeSchema } from "../world/recipe-schema.js";

/**
 * Validation for a pack an author wrote.
 *
 * Every table is optional, because an override is meant to be small — a scenario
 * that only wants its own family names writes six lines. What is *not* optional is
 * that a table which is present is non-empty: an empty `given` list would make
 * `personName` index into nothing and hand back `undefined undefined` for every
 * person in the world, which is far worse than the pack having been rejected.
 *
 * Shares `WorldLoreSchema` with the director rather than restating it, so a pack
 * cannot describe a shape the model is not allowed to produce.
 */

const words = (max: number) => z.array(z.string().min(1).max(max)).min(1);

const OutdoorRoleSchema = z.object({
	role: z.string().min(1).max(40),
	placement: z.string().min(1).max(24),
});

const HouseholdSchema = z.object({
	/** Low then high, inclusive. Low may be zero: some buildings are empty. */
	count: z.tuple([z.number().int().min(0).max(8), z.number().int().min(0).max(8)]),
	roles: z.array(z.string().min(1).max(40)).max(12),
});

/**
 * A thing and its one line, as a pack writes one.
 *
 * The description is not decoration: it is what the examine verb prints and what
 * `basePrice` reads for its keyword hints, so an item with an empty one is an item that
 * costs the base price and reads as a bug.
 */
const GoodsEntrySchema = z.tuple([z.string().min(1).max(60), z.string().min(1).max(200)]);

const GoodsTableSchema = z.record(z.string().min(1), z.array(GoodsEntrySchema).max(24));

const TradeSchema = z
	.object({
		kind: z.string().min(1).max(40),
		roles: z.array(z.string().min(1).max(40)).min(1).max(16),
	})
	.strict();

const GoodsOverrideSchema = z
	.object({
		stores: GoodsTableSchema.optional(),
		catalogue: GoodsTableSchema.optional(),
		trades: z.array(TradeSchema).max(24).optional(),
		yields: GoodsTableSchema.optional(),
		// A ground that always yields is a shop, and one that never does is scenery an
		// errand may still be written about. Neither end is refused, only bounded.
		forageChance: z.record(z.string().min(1), z.number().min(0).max(1)).optional(),
	})
	.strict();

export const PackOverrideSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug")
		.optional(),
	// The one table that is not cosmetic. Validated by the recipe's own schema rather
	// than by a copy of it, so a pack cannot ask the generator for something a recipe
	// file could not.
	world: WorldRecipeSchema.optional(),
	names: z
		.object({
			given: words(24).optional(),
			family: words(32).optional(),
			heads: z
				.object({
					wet: words(16).optional(),
					green: words(16).optional(),
					cold: words(16).optional(),
					dry: words(16).optional(),
					high: words(16).optional(),
					plain: words(16).optional(),
				})
				.optional(),
			tails: words(16).optional(),
			ruinTails: words(16).optional(),
			fortTails: words(16).optional(),
			regionTails: words(16).optional(),
		})
		.optional(),
	households: z.record(z.string().min(1), HouseholdSchema).optional(),
	appearance: z.record(z.string().min(1), z.string().min(1).max(200)).optional(),
	talksAbout: z.record(z.string().min(1), z.string().min(1).max(160)).optional(),
	outdoorRoles: z.record(z.string().min(1), OutdoorRoleSchema).optional(),
	wanderers: z.array(OutdoorRoleSchema).max(12).optional(),
	lore: WorldLoreSchema.optional(),
	ambient: z.array(z.string().min(1).max(200)).max(12).optional(),
	goods: GoodsOverrideSchema.optional(),
});

/**
 * The full pack, for validating the shipped default against the compiled one.
 *
 * Requires everything the override makes optional, which is what makes the asset a
 * complete worked example rather than a fragment an author has to guess at.
 */
export const ContentPackSchema = z.object({
	id: z.string().min(1),
	names: z.object({
		given: words(24),
		family: words(32),
		heads: z.object({
			wet: words(16),
			green: words(16),
			cold: words(16),
			dry: words(16),
			high: words(16),
			plain: words(16),
		}),
		tails: words(16),
		ruinTails: words(16),
		fortTails: words(16),
		regionTails: words(16),
	}),
	households: z.record(z.string().min(1), HouseholdSchema),
	appearance: z.record(z.string().min(1), z.string().min(1).max(200)),
	talksAbout: z.record(z.string().min(1), z.string().min(1).max(160)),
	outdoorRoles: z.record(z.string().min(1), OutdoorRoleSchema),
	wanderers: z.array(OutdoorRoleSchema).max(12),
	lore: WorldLoreSchema,
	ambient: z.array(z.string().min(1).max(200)).max(12),
	goods: z
		.object({
			stores: GoodsTableSchema,
			catalogue: GoodsTableSchema,
			trades: z.array(TradeSchema).max(24),
			yields: GoodsTableSchema,
			forageChance: z.record(z.string().min(1), z.number().min(0).max(1)),
		})
		.strict(),
});
