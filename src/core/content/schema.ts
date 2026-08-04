import { z } from "zod";
import { WorldLoreSchema } from "../../ai/director/schemas.js";

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

export const PackOverrideSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug")
		.optional(),
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
});
