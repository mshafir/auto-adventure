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

/**
 * One world, offered rather than written.
 *
 * Three fields and no more. The player is choosing between four of these on one screen, so
 * anything that does not help them choose is a line pushing the fourth option off the
 * bottom — and everything else about the world is the lore pass's job anyway.
 */
export const PitchSchema = z.object({
	title: cappedText(60).describe("The world's name. Two to five words, no subtitle."),
	tone: cappedText(24).describe("Its register, in one or two words: 'sombre', 'wry'."),
	premise: cappedText(400).describe("What the player is caught up in, in two to four sentences."),
});

export const PitchesSchema = z.object({
	pitches: z
		.array(PitchSchema)
		.min(1)
		.transform((v) => v.slice(0, 8)),
});

export type PitchResponse = z.infer<typeof PitchSchema>;

/**
 * Something the world does once a step of the story has happened.
 *
 * The condition is an *index into the beats it was shown*, never a flag the model writes,
 * which is the whole safety property: a trigger cannot wait on a flag nothing sets,
 * because it is not allowed to name one. Out-of-range indices are dropped, exactly as
 * with a beat's site index.
 */
export const ReactionSchema = z.object({
	id: slugText(48).describe("Short stable slug, e.g. 'the-mill-burns'."),
	afterBeat: z
		.number()
		.int()
		.min(0)
		.describe("Index into the list of beats. This happens once that beat has opened."),
	journal: cappedText(240)
		.nullable()
		.describe("One line written into the player's journal, in their voice. Null for none."),
	cardTitle: cappedText(80).nullable().describe("Title of a full screen shown, or null."),
	cardBody: cappedText(600)
		.nullable()
		.describe("Two or three short paragraphs. Only used when cardTitle is given."),
});

/**
 * A gate across the one place in the world that has a single way in.
 *
 * Named by index into the castles the prompt lists, and opened by a beat index, so the
 * model never writes a coordinate or a flag. Only castles are offered: a village's
 * streets have as many ways in as they have edges, so barring one tile of an open road
 * bars nothing and says it did.
 */
export const BarrierSchema = z.object({
	id: slugText(48),
	castle: z.number().int().min(0).describe("Index into the list of castles."),
	opensAfterBeat: z.number().int().min(0).describe("Index into the list of beats."),
	lockedText: cappedText(200).describe("What the player is told when it will not open."),
	opensText: cappedText(200).nullable().describe("Said once as the way opens, or null."),
});

export const ReactionsSchema = z.object({
	triggers: cappedList(ReactionSchema, 4),
	barriers: cappedList(BarrierSchema, 2),
});

export type ReactionsResponse = z.infer<typeof ReactionsSchema>;

/**
 * One thing a reader thinks would stop a player finishing this world.
 *
 * Named by beat index, like everything else a model is asked to point at here, so a note
 * can be attached to the scene it is about and handed to the rewrite of that scene. A note
 * about nothing in particular says -1 and is reported rather than acted on.
 *
 * `fixable` is the model's own judgement about whether rewriting the conversation would
 * cure it, and it is *advisory*: the pass below decides what it attempts on the strength of
 * what it can re-derive, and re-validates afterwards. Asking is still worth it, because
 * "the map is too big for this story" and "this character never says where to go" both
 * come back as prose and only one of them is worth a call.
 */
export const ReadingNoteSchema = z.object({
	beat: z
		.number()
		.int()
		.min(-1)
		.describe("Index into the list of beats this is about, or -1 for the story as a whole."),
	what: cappedText(300).describe("What would go wrong for the player, in one or two sentences."),
	fixable: z
		.boolean()
		.describe("Whether rewriting that scene's conversation would fix it, as far as you can tell."),
});

export const ReadingSchema = z.object({
	/**
	 * Asked for even when the answer is "nothing", because a model with a list to fill will
	 * fill it: a schema that only carries faults invites the invention of faults. A verdict
	 * gives it somewhere to say the world is sound.
	 */
	verdict: cappedText(200).describe("One sentence: could a player follow this story through?"),
	notes: cappedList(ReadingNoteSchema, 6),
});

export type ReadingResponse = z.infer<typeof ReadingSchema>;

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
