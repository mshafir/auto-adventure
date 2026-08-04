import { z } from "zod";
import { ActionSchema } from "../dialogue/schema.js";

/**
 * What the authoring passes are allowed to say.
 *
 * Narrower than the runtime types on purpose. The model chooses *which* surveyed
 * site a beat happens at and *which* of its people opens it, by index into lists it
 * was shown — it does not get to invent a site id or an npc slot, because a
 * hallucinated one is a story that silently never starts. The tool resolves the
 * indices into real ids afterwards.
 */

export const ArcBeatSchema = z.object({
	id: z
		.string()
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug")
		.describe("Short stable slug, e.g. 'meet-the-clerk'."),
	/** Index into the list of settlements the prompt showed. */
	siteIndex: z.number().int().min(0),
	/** Index into that settlement's people, as listed. */
	npcIndex: z.number().int().min(0),
	summary: z.string().max(200).describe("What happens, for the author's eyes."),
	journal: z
		.string()
		.max(240)
		.nullable()
		.describe("One line written into the player's journal, in their voice."),
	quest: z
		.object({
			name: z.string().max(80),
			description: z.string().max(240),
			objective: z
				.object({
					kind: z.enum(["have", "reach", "talk", "flag"]),
					target: z.string().max(80),
					quantity: z.number().int().min(1).max(9).nullable(),
				})
				.nullable()
				.describe("What finishes it. Null for a beat that is only a revelation."),
		})
		.nullable(),
});

export const ArcSchema = z.object({
	title: z.string().max(80).describe("The story's name, not the world's."),
	premise: z.string().max(400).describe("What the player is caught up in, in two sentences."),
	beats: z.array(ArcBeatSchema).min(1).max(12),
});

const TreeChoiceSchema = z.object({
	text: z.string().max(90).describe("What the player says, in the player's voice."),
	goto: z.string().max(48).nullable().describe("Id of the next node, or null to end."),
	requiresFlag: z
		.string()
		.max(64)
		.nullable()
		.describe("Hide this reply until the story has set this flag."),
});

export const TreeNodeSchema = z.object({
	id: z
		.string()
		.max(48)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case slug"),
	speech: z.string().max(400).describe("What they say. One or two sentences, in their voice."),
	requiresFlag: z
		.string()
		.max(64)
		.nullable()
		.describe("Only usable as an opening once this flag is set."),
	choices: z.array(TreeChoiceSchema).max(4),
	actions: z.array(ActionSchema).max(2),
});

export const TreeSchema = z.object({
	entry: z.string().max(48).describe("Id of the node a first meeting starts at."),
	entryAfter: z
		.array(z.object({ node: z.string().max(48), flag: z.string().max(64) }))
		.max(2)
		.describe("Alternative openings, each used once its flag is set."),
	revisit: z.string().max(48).nullable().describe("Id of the node later meetings start at."),
	nodes: z.array(TreeNodeSchema).min(2).max(10),
});

export type ArcResponse = z.infer<typeof ArcSchema>;
export type TreeResponse = z.infer<typeof TreeSchema>;
