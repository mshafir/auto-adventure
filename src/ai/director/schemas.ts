import { z } from "zod";

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

export const STRUCTURE_KINDS = [
	"house",
	"shop",
	"inn",
	"smithy",
	"temple",
	"barracks",
	"tower",
	"farmhouse",
	"barn",
	"warehouse",
	"mill",
	"stable",
	"apothecary",
	"ruin",
	"shrine",
] as const;

/** Anchors an NPC may stand at. Indoor anchors are excluded on purpose: NPCs
 * are placed in the open so the player can see and reach them without an
 * interior entity system. */
export const PLACEMENTS = ["square", "well", "stall", "bench", "gate", "doorstep", "yard"] as const;

export const WorldLoreSchema = z.object({
	title: z.string().max(60).describe("Name of this world. Two or three words."),
	premise: z.string().max(400).describe("What has just happened here, in two sentences."),
	era: z.string().max(80),
	tone: z.string().max(80).describe("e.g. 'wry and weatherbeaten', 'quiet folk-horror'"),
	factions: z.array(z.string().max(60)).min(2).max(4),
	deities: z.array(z.string().max(60)).max(3),
});

export const RegionSpecSchema = z.object({
	name: z.string().max(60).describe("Region name, without a leading 'the'."),
	blurb: z.string().max(300),
	tone: z.string().max(80),
	culture: z.string().max(160).describe("How people here live, in one clause."),
	factionName: z.string().max(60).nullable(),
	lore: z.array(z.string().max(200)).max(4),
	ambient: z
		.array(z.string().max(120))
		.max(5)
		.describe("Second-person sensory lines shown as the player travels."),
});

export const StructureSpecSchema = z.object({
	kind: z.enum(STRUCTURE_KINDS),
	name: z.string().max(60).nullable().describe("Proper name, e.g. 'The Drowned Lamp'."),
	signText: z
		.string()
		.max(60)
		.nullable()
		.describe("Words painted on the board outside. Only for shops and inns."),
	size: z.enum(["small", "medium", "large"]),
	importance: z.number().int().min(1).max(5),
});

export const NpcSpecSchema = z.object({
	name: z.string().max(60),
	role: z.string().max(40).describe("e.g. 'blacksmith', 'toll clerk', 'wandering priest'"),
	glyph: z
		.string()
		.regex(/^[A-Za-z]$/)
		.describe("One letter, usually the first letter of the role."),
	appearance: z.string().max(200),
	persona: z.string().max(300).describe("How they speak and what they want."),
	disposition: z.number().int().min(-40).max(60),
	placement: z.enum(PLACEMENTS),
	structureName: z.string().max(60).nullable(),
	knows: z.array(z.string().max(160)).max(4).describe("Things this NPC can tell the player."),
});

export const SiteSpecSchema = z.object({
	name: z.string().max(60),
	shortName: z.string().max(24),
	description: z.string().max(400),
	walled: z.boolean(),
	structures: z.array(StructureSpecSchema).max(16),
	npcs: z.array(NpcSpecSchema).max(6),
	hooks: z.array(z.string().max(200)).max(2),
});

export type WorldLoreResponse = z.infer<typeof WorldLoreSchema>;
export type RegionSpecResponse = z.infer<typeof RegionSpecSchema>;
export type SiteSpecResponse = z.infer<typeof SiteSpecSchema>;
