import { z } from "zod";
import { ActionSchema } from "../dialogue/schema.js";
import { STRUCTURE_KINDS } from "../director/schemas.js";

/**
 * What the authoring passes are allowed to say.
 *
 * Narrower than the runtime types on purpose. The model chooses *which* surveyed
 * site a beat happens at and *which* of its people opens it, by index into lists it
 * was shown — it does not get to invent a site id or an npc slot, because a
 * hallucinated one is a story that silently never starts. The tool resolves the
 * indices into real ids afterwards.
 */

/**
 * A world the model asks for, before the survey runs.
 *
 * Narrow on purpose, and much narrower than a `WorldRecipe`: the model gets the four
 * knobs that answer "what kind of country is this" and nothing that could break the
 * generator. `places` and `zones` are deliberately absent — those need coordinates, and
 * a coordinate is precisely the sort of thing a model invents confidently and wrongly.
 * An author writing by hand has the survey in front of them and can place a town; a
 * model asked for the world before the survey exists cannot.
 */
export const WorldShapeSchema = z.object({
	sea: z
		.enum(["drowned", "coastal", "ordinary", "landlocked"])
		.describe("How much of this world is water."),
	climate: z
		.enum(["frozen", "cold", "temperate", "hot", "scorched"])
		.describe("How warm it is overall."),
	wet: z.enum(["arid", "dry", "ordinary", "lush", "rain-drowned"]).describe("How wet it is."),
	settled: z
		.enum(["empty", "sparse", "ordinary", "crowded"])
		.describe("How thickly people live here."),
	woods: z
		.enum(["bare", "thin", "ordinary", "thick", "overgrown"])
		.describe("How dense the woodland is where there is any."),
	why: z.string().max(200).describe("One sentence on why this suits the brief."),
});

export type WorldShapeResponse = z.infer<typeof WorldShapeSchema>;

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
	/**
	 * A side errand: worth doing, not on the way to the end.
	 *
	 * The whole reason `arcOutline` distinguishes them — the story can finish with an
	 * optional beat still open, and a player who never found it has still finished.
	 */
	optional: z.boolean().describe("True for a side errand nobody has to do."),
	/**
	 * The id of a beat this one is a step of.
	 *
	 * Makes the story a graph rather than a line: the parent cannot close until this
	 * does, because the tool adds a `quest` objective on the parent naming it.
	 */
	partOf: z
		.string()
		.max(48)
		.nullable()
		.describe("Id of an earlier beat this is one step of, or null."),
	/**
	 * Two beats sharing a `branch` are mutually exclusive: taking one bars the other.
	 *
	 * This is what makes a choice a choice. Give both arms the same short group name.
	 */
	branch: z
		.string()
		.max(48)
		.nullable()
		.describe("Group name shared with the beats this one is an alternative to."),
	/**
	 * Something hidden that the player has to go and find.
	 *
	 * The engine puts it in a container inside a named kind of building at the beat's
	 * own settlement, and adds an objective to carry it — so the beat cannot close
	 * until the player has actually been and got it.
	 */
	find: z
		.object({
			item: z.string().max(60).describe("What it is called."),
			description: z.string().max(160),
			where: z
				.enum(STRUCTURE_KINDS)
				.describe("Which kind of building at this settlement it is hidden in."),
		})
		.nullable(),
});

/** An ending the story can reach, chosen by which arm of a fork was taken. */
export const ArcEndingSchema = z.object({
	branch: z.string().max(48).describe("Group name of the fork."),
	beat: z.string().max(48).describe("Id of the arm that leads here."),
	title: z.string().max(80),
	heading: z.string().min(1).max(40).describe("A short heading over the text, e.g. 'After'."),
	body: z.string().max(600).describe("The last page, in two or three short paragraphs."),
});

export const ArcSchema = z.object({
	title: z.string().max(80).describe("The story's name, not the world's."),
	premise: z.string().max(400).describe("What the player is caught up in, in two sentences."),
	beats: z.array(ArcBeatSchema).min(1).max(12),
	/** One per arm of each fork. An ending with no matching arm is dropped. */
	endings: z.array(ArcEndingSchema).max(6),
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
