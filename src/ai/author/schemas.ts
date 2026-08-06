import { z } from "zod";
import { ActionSchema } from "../dialogue/schema.js";
import { STRUCTURE_KINDS } from "../director/schemas.js";
import { cappedInt, cappedList, cappedText, slugText } from "../limits.js";

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
 * Narrow on purpose, and much narrower than a `WorldRecipe`: the model gets the handful
 * of knobs that answer "what kind of country is this" and nothing that could break the
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
	// The three kinds that are weighted at zero in the default world, asked for by
	// name because they are the difference between country you walk through and
	// country with something in it. Coarser than the settlement knob deliberately:
	// these are landmarks, and a map with "some" castles on it has perhaps two or
	// three, not a skyline of them.
	strongholds: z
		.enum(["none", "few", "some"])
		.describe("Castles and walled keeps. Wants high, level ground to stand on."),
	caves: z.enum(["none", "few", "some"]).describe("Cave mouths. Want a hillside to open into."),
	harbours: z
		.enum(["none", "few", "some"])
		.describe("Docks and jetties. Want a shoreline, so pointless in a landlocked world."),
	why: cappedText(200).describe("One sentence on why this suits the brief."),
});

export type WorldShapeResponse = z.infer<typeof WorldShapeSchema>;

export const ArcBeatSchema = z.object({
	id: slugText(48).describe("Short stable slug, e.g. 'meet-the-clerk'."),
	/** Index into the list of settlements the prompt showed. */
	siteIndex: z.number().int().min(0),
	/** Index into that settlement's people, as listed. */
	npcIndex: z.number().int().min(0),
	summary: cappedText(200).describe("What happens, for the author's eyes."),
	journal: cappedText(240)
		.nullable()
		.describe("One line written into the player's journal, in their voice."),
	quest: z
		.object({
			name: cappedText(80),
			description: cappedText(240),
			objective: z
				.object({
					kind: z.enum(["have", "reach", "talk", "flag"]),
					target: cappedText(80),
					quantity: cappedInt(1, 9).nullable(),
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
	partOf: slugText(48).nullable().describe("Id of an earlier beat this is one step of, or null."),
	/**
	 * Two beats sharing a `branch` are mutually exclusive: taking one bars the other.
	 *
	 * This is what makes a choice a choice. Give both arms the same short group name.
	 */
	branch: slugText(48)
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
			item: cappedText(60).describe("What it is called."),
			description: cappedText(160),
			where: z
				.enum(STRUCTURE_KINDS)
				.describe("Which kind of building at this settlement it is hidden in."),
		})
		.nullable(),
});

/** An ending the story can reach, chosen by which arm of a fork was taken. */
export const ArcEndingSchema = z.object({
	branch: slugText(48).describe("Group name of the fork."),
	beat: slugText(48).describe("Id of the arm that leads here."),
	title: cappedText(80),
	heading: cappedText(40).pipe(z.string().min(1)).describe("A short heading, e.g. 'After'."),
	body: cappedText(600).describe("The last page, in two or three short paragraphs."),
});

export const ArcSchema = z.object({
	title: cappedText(80).describe("The story's name, not the world's."),
	premise: cappedText(400).describe("What the player is caught up in, in two sentences."),
	beats: z
		.array(ArcBeatSchema)
		.min(1)
		.transform((v) => v.slice(0, 12)),
	/** One per arm of each fork. An ending with no matching arm is dropped. */
	endings: cappedList(ArcEndingSchema, 6),
});

const TreeChoiceSchema = z.object({
	text: cappedText(90).describe("What the player says, in the player's voice."),
	goto: slugText(48).nullable().describe("Id of the next node, or null to end."),
	requiresFlag: cappedText(64)
		.nullable()
		.describe("Hide this reply until the story has set this flag."),
});

export const TreeNodeSchema = z.object({
	id: slugText(48),
	speech: cappedText(400).describe("What they say. One or two sentences, in their voice."),
	requiresFlag: cappedText(64)
		.nullable()
		.describe("Only usable as an opening once this flag is set."),
	choices: cappedList(TreeChoiceSchema, 4),
	actions: cappedList(ActionSchema, 2),
});

export const TreeSchema = z.object({
	entry: slugText(48).describe("Id of the node a first meeting starts at."),
	entryAfter: cappedList(z.object({ node: slugText(48), flag: cappedText(64) }), 2).describe(
		"Alternative openings, each used once its flag is set.",
	),
	revisit: slugText(48).nullable().describe("Id of the node later meetings start at."),
	nodes: z
		.array(TreeNodeSchema)
		.min(2)
		.transform((v) => v.slice(0, 10)),
});

export type ArcResponse = z.infer<typeof ArcSchema>;
export type TreeResponse = z.infer<typeof TreeSchema>;
