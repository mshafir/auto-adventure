import { z } from "zod";
import type { StructureKind } from "../../core/gen/features/patch.js";
import { authorableStructureKinds } from "../../core/gen/features/structures.js";
import { cappedInt, cappedList, cappedText } from "../limits.js";

/**
 * What the director is allowed to say.
 *
 * These schemas are the entire surface through which a model influences the
 * world, and they are deliberately narrow: the model picks *from* a closed set
 * of structure kinds and anchor kinds, and its numbers are clamped by the
 * schema before the generator ever sees them. It cannot invent a building type
 * the generator has no plan for, cannot ask for a hundred houses, and cannot
 * place an NPC somewhere the settlement pass never puts an anchor.
 *
 * Everything here has a deterministic counterpart in `fallback.ts`.
 */

/**
 * The buildings an author may ask for, derived from the structure registry.
 *
 * This was a hand-maintained copy of `StructureKind` with one entry missing, and the
 * missing entry was correct — `cave` is built by the cave feature, not asked for by a
 * roster — but nothing said so and nothing checked it. A copy that is *deliberately*
 * short by one is indistinguishable from a copy somebody forgot to update, and the
 * symptom of the second is a scenario that validates and then generates a building with
 * no plan behind it. `authorable` on the registered kind says which is which, in the one
 * place that also says what the building is made of.
 */
export const STRUCTURE_KINDS = authorableStructureKinds() as readonly [
	StructureKind,
	...StructureKind[],
];

/** Anchors an NPC may stand at. Indoor anchors are excluded on purpose: NPCs
 * are placed in the open so the player can see and reach them without an
 * interior entity system. */
export const PLACEMENTS = ["square", "well", "stall", "bench", "gate", "doorstep", "yard"] as const;

export const WorldLoreSchema = z.object({
	title: cappedText(60).describe("Name of this world. Two or three words."),
	premise: cappedText(400).describe("What has just happened here, in two sentences."),
	era: cappedText(80),
	tone: cappedText(80).describe("e.g. 'wry and weatherbeaten', 'quiet folk-horror'"),
	factions: z
		.array(cappedText(60))
		.min(2)
		.transform((v) => v.slice(0, 4)),
	deities: cappedList(cappedText(60), 3),
});

export const RegionSpecSchema = z.object({
	name: cappedText(60).describe("Region name, without a leading 'the'."),
	blurb: cappedText(300),
	tone: cappedText(80),
	culture: cappedText(160).describe("How people here live, in one clause."),
	factionName: cappedText(60).nullable(),
	lore: cappedList(cappedText(200), 4),
	ambient: cappedList(cappedText(120), 5).describe(
		"Second-person sensory lines shown as the player travels.",
	),
});

export const StructureSpecSchema = z.object({
	kind: z.enum(STRUCTURE_KINDS),
	name: cappedText(60).nullable().describe("Proper name, e.g. 'The Drowned Lamp'."),
	signText: cappedText(60)
		.nullable()
		.describe("Words painted on the board outside. Only for shops and inns."),
	size: z.enum(["small", "medium", "large"]),
	importance: cappedInt(1, 5),
});

export const NpcSpecSchema = z.object({
	name: cappedText(60),
	role: cappedText(40).describe("e.g. 'blacksmith', 'toll clerk', 'wandering priest'"),
	glyph: z
		.string()
		.regex(/^[A-Za-z]$/)
		.describe("One letter, usually the first letter of the role."),
	appearance: cappedText(200),
	persona: cappedText(300).describe("How they speak and what they want."),
	disposition: cappedInt(-40, 60),
	placement: z.enum(PLACEMENTS),
	structureName: cappedText(60).nullable(),
	knows: cappedList(cappedText(160), 4).describe("Things this NPC can tell the player."),
});

export const SiteSpecSchema = z.object({
	name: cappedText(60),
	shortName: cappedText(24),
	description: cappedText(400),
	walled: z.boolean(),
	structures: cappedList(StructureSpecSchema, 16),
	npcs: cappedList(NpcSpecSchema, 6),
	hooks: cappedList(cappedText(200), 2),
});

export type WorldLoreResponse = z.infer<typeof WorldLoreSchema>;
export type RegionSpecResponse = z.infer<typeof RegionSpecSchema>;
export type SiteSpecResponse = z.infer<typeof SiteSpecSchema>;
