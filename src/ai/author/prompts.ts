import type { Duration, ScenarioBrief } from "../../core/world/brief.js";
import type { NpcSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";
import type { SurveyedSite } from "../../scenario/survey.js";

/**
 * The authoring prompts.
 *
 * Same rule as `prompt.ts`: the model is told what the engine has already decided
 * and asked to make it mean something. What is different here is *how much* is
 * already decided — the whole map, not one chunk's halo — so the arc can be placed
 * against real distances and real town sizes instead of hoping.
 */

/**
 * How everything in this world is written.
 *
 * Rewritten after a playthrough of a generated world that was well-written and unplayable.
 * The prose was good — atmospheric, allusive, every line carrying its weight — and the
 * player could not work out what to do next, because "concrete and specific" turns out to
 * license a model to be concrete and specific about *the wrong things*: the smell of the
 * weighing station, in detail, and the name of the town they were supposed to walk to
 * nowhere at all.
 *
 * So the instruction now separates the two registers. Description may be as good as it
 * likes. Anything the player has to *act on* — an errand, a journal line, what somebody
 * says when they hand out a job — is plain, short, and names the thing: the place, the
 * person, the object. A story is not spoiled by saying where to go; it is spoiled by the
 * player standing in a field guessing.
 */
const HOUSE_STYLE =
	"Write like a good tabletop GM: concrete, specific, unsentimental. " +
	"Prefer one telling detail to three adjectives. Never mention game mechanics, " +
	"tiles, chunks, seeds, or that this is generated. No markdown, no lists in prose fields. " +
	"Use plain words: short sentences, everyday vocabulary, and no riddling. " +
	"When you tell the player to do something, say it outright and name the place, the " +
	"person or the thing by the name the world uses for it. Atmosphere goes in description; " +
	"instructions are never allusive.";

export const ARC_SYSTEM =
	`You plot the story of a small terminal roguelike. ${HOUSE_STYLE} ` +
	"You are given a world that already exists: its towns, their sizes, who lives in " +
	"them and how far apart they are. Place a story through it. You may not invent a " +
	"settlement, move one, or add a person — choose from what is listed.";

export const PITCH_SYSTEM =
	`You pitch worlds for a small terminal roguelike. ${HOUSE_STYLE} ` +
	"Each pitch is a whole world in three lines: what it is called, its register, and what " +
	"the player has walked into. They must differ from each other in kind and not merely in " +
	"decoration — four ways to be a fishing village is one idea told four times.";

/**
 * What a world could be, before any of it exists.
 *
 * The one authoring prompt with no survey behind it, and deliberately so: the premise
 * decides the scenario's id and therefore its seed, so it has to be settled before a single
 * tile is generated. The model is inventing rather than describing, which is why this asks
 * for difference between the options — the failure mode of a list like this is four
 * paraphrases of whichever one the model thought of first.
 */
export function pitchPrompt(input: {
	readonly duration: Duration;
	readonly count: number;
	readonly hint?: string;
	readonly avoid?: readonly string[];
}): string {
	const lines = [
		`Offer ${input.count} worlds to play in, as different from each other as you can make them.`,
		`Each will be a ${input.duration} scenario: ${LENGTH_NOTE[input.duration]}`,
		"A traveller on foot is the protagonist, and a village blacksmith should plausibly have",
		"an opinion about whatever has happened.",
	];
	if (input.hint) {
		lines.push("", "The player has said what they are after. Follow it:", input.hint);
	}
	if (input.avoid && input.avoid.length > 0) {
		// Named rather than described, because "something different" is advice a model can
		// satisfy without changing anything.
		lines.push(
			"",
			"These have already been offered and refused. Do not repeat them or reword them:",
			input.avoid.map((title) => `- ${title}`).join("\n"),
		);
	}
	return lines.join("\n");
}

/** What each length can actually hold, so a pitch is not bigger than its world. */
const LENGTH_NOTE: Readonly<Record<Duration, string>> = {
	tiny: "a few places and two scenes, so keep the stakes local and the cast small.",
	short: "a handful of places and three scenes — an evening.",
	medium: "a dozen or so places and six scenes, with room to wander between them.",
	long: "a large map, ten scenes, side errands and a fork or two.",
};

function briefLines(brief: ScenarioBrief): string[] {
	const lines: string[] = [];
	if (brief.premise) lines.push(brief.premise);
	if (brief.setting) lines.push(`Setting: ${brief.setting}`);
	if (brief.storyline) lines.push(`Storyline: ${brief.storyline}`);
	if (brief.protagonist) lines.push(`The player: ${brief.protagonist}`);
	if (brief.tone) lines.push(`Tone: ${brief.tone}`);
	if (brief.avoid) lines.push(`Avoid: ${brief.avoid}`);
	return lines;
}

/** One line per settlement, with everything the model needs to choose. */
function siteLine(index: number, entry: SurveyedSite, spec: SiteSpec): string {
	const people = spec.npcs.map((npc, slot) => `${slot}=${npc.name} the ${npc.role}`).join(", ");
	return [
		`[${index}] ${spec.name} — a ${entry.site.kind}, ${entry.distanceFromSpawn} tiles from the start.`,
		`     ${spec.description}`,
		`     People: ${people || "nobody"}`,
	].join("\n");
}

/**
 * How many side errands a story of this length should carry.
 *
 * About one per three beats. Fewer than that and the map is scenery between conversations;
 * many more and the main line stops being findable among them. The count is asked for
 * explicitly because a range was ignored: every generated arc came back with none at all
 * while `optional` sat in the schema, documented and unused.
 *
 * The floor used to be *one*, and it was wrong in a way two real generated worlds showed.
 * A `tiny` world has two beats, so demanding one side errand left a main line of exactly
 * one beat: the player arrives, has a conversation, and the story is over — with the only
 * other thing to do marked as refusable. Both worlds read as having no direction at all,
 * and no check could say so, because there was no second main beat for anything to be
 * unclear *about*.
 *
 * So the main line keeps three beats before a side errand is asked for at all. Three is
 * where a story starts being a road rather than a scene: somewhere to be given the errand,
 * somewhere to take it, and somewhere it turns out to lead.
 */
export const MAIN_LINE_FLOOR = 3;

function optionalWanted(beats: number): number {
	return Math.max(0, Math.min(Math.round(beats / 3), beats - MAIN_LINE_FLOOR));
}

export function arcPrompt(input: {
	readonly brief: ScenarioBrief;
	readonly lore: WorldLore;
	readonly beats: number;
	readonly sites: readonly { readonly entry: SurveyedSite; readonly spec: SiteSpec }[];
}): string {
	const lines = input.sites.map((site, index) => siteLine(index, site.entry, site.spec));
	return [
		`World: ${input.lore.title}. ${input.lore.premise}`,
		`Tone: ${input.lore.tone}. Factions: ${input.lore.factions.join(", ")}.`,
		"",
		...(briefLines(input.brief).length > 0
			? ["What the author asked for:", ...briefLines(input.brief), ""]
			: []),
		"The world, as it already stands:",
		...lines,
		"",
		`Plot exactly ${input.beats} beats. Each is one thing the player learns or is asked to do,`,
		"and each is opened by talking to one specific person from the lists above — give the index",
		"of the settlement and the index of the person within it.",
		"",
		"Order them so the player travels outward rather than back and forth: beat one should be",
		"close to the start. Beats later in the story may be further away. Not every beat needs a",
		"quest; a beat that is only a revelation is good pacing. When a beat does have a quest, its",
		"objective must be something the world can actually satisfy — an item somebody hands over, a",
		"place with a name listed above, or a person named above.",
		"",
		// The fault a playthrough found, which nothing in the schema had ever asked about.
		// Every beat opened and every errand landed, and the player finished a scene holding
		// a journal line about the tallies and six towns to choose between. The story was
		// perfectly sound and completely unfollowable.
		"Every beat must say where the player goes next. When the next beat is in a different",
		"settlement, write its name in this beat's journal line or in its quest description —",
		"the name exactly as it is spelled in the list above — and name the person to ask for.",
		'Do not make the player infer it. "Ask for Lune Harrowgate at Aldermoor" is the line;',
		'"the answer lies northward, if you have the wit to find it" is not, however much better',
		"it reads.",
		"",
		"The last beat should end the story, not open another door.",
		"",
		// Both of these were available before and neither was ever used: every generated
		// world came back with zero side errands and zero hidden things, because "you may"
		// reads as "you need not" and the straight line is always the easier thing to write.
		// A story of nothing but main beats is a story of walking between conversations.
		//
		// But a short story cannot spare one, and asking anyway is what produced two real
		// worlds with a main line of a single beat — see `optionalWanted`. So the demand is
		// dropped rather than scaled at that length, and the hidden thing is asked for either
		// way: something to search for is what makes a beat happen in a place.
		...(optionalWanted(input.beats) > 0
			? [
					`Two of these are required. ${optionalWanted(input.beats)} of those ${input.beats} beats must`,
					"be side errands marked optional, and at least one beat must hide something to find:",
					"",
					"  optional  A side errand, off the main line. The story can finish with it still open,",
					"            so this is where a piece of the world that is worth finding but not on the",
					"            way belongs. It is what makes the map worth leaving the road for.",
					"  find      Something hidden. Name it, say which kind of building at that settlement",
					"            it is in, and the player has to go and get it before the beat closes.",
					"            A story where nothing is ever searched for is a story with no objects in it.",
				]
			: [
					`This story is only ${input.beats} beats long, so every one of them is on the main`,
					"line. Mark none of them optional — a story this short cannot spare a beat for a side",
					"errand, and one that does leaves the player with a single thing to do and no road.",
					"",
					"One thing is still required: at least one beat must hide something to find.",
					"",
					"  find      Something hidden. Name it, say which kind of building at that settlement",
					"            it is in, and the player has to go and get it before the beat closes.",
					"            A story where nothing is ever searched for is a story with no objects in it.",
				]),
		"",
		"Two more you may use, neither required, and only where they make the story better",
		"than a straight line would. Use at most one fork:",
		"",
		"  partOf    Give a beat the id of an earlier one, and it becomes a step of it: the",
		"            earlier errand cannot close until this one does. Two or three steps under",
		"            one job reads far better than three unrelated jobs. Never point an arm of",
		"            a fork at its own sibling — each arm follows what came before the fork.",
		"  branch    Two beats with the same branch name are alternatives. Taking one bars the",
		"            other for good. Use it for a decision the player should not be able to",
		"            take back — who to tell, which side to take — and write an ending for",
		"            each arm.",
		"",
		"If you use a branch, write one ending per arm: name the branch group and the beat, and",
		"say what the world looks like afterwards. Otherwise write no endings at all.",
	].join("\n");
}

export const SHAPE_SYSTEM =
	"You choose what kind of country a story happens in. You are given a brief and nothing " +
	"else. Answer with the settings and one sentence saying why. Do not write prose, " +
	"do not name places, and do not describe a plot.";

/**
 * Ask what kind of world the brief wants, before the world exists.
 *
 * The one authoring decision that has to be made *first*: the survey runs against a
 * world, so the world has to be chosen before there is anything to survey. Deliberately
 * coarse settings rather than a recipe — a model handed `seaLevel` will write
 * `0.9` and drown the map, and it has no coordinates to place anything against yet.
 */
export function shapePrompt(brief: ScenarioBrief): string {
	const lines = briefLines(brief);
	return [
		lines.length > 0 ? "What the author asked for:" : "The author asked for nothing in particular.",
		...lines,
		"",
		"Pick the country this belongs in. An archipelago tale needs water; a story about a",
		"road through nowhere needs the map to be mostly empty. When the brief does not care,",
		"say 'ordinary' — an ordinary world is a good world and there is no prize for exotica.",
		"",
		"Castles, caves and harbours are the exception to that: the default world has none of",
		"any of them, so leaving all three at 'none' gives a map of villages and farmland and",
		"nothing to walk towards. Ask for what the story needs somewhere to happen in — a siege",
		"needs a stronghold, a smuggling tale needs a harbour, something buried needs a cave.",
		"'few' is two or three across the whole world, which is usually enough. Do not ask for",
		"harbours in a landlocked world; there is no shore for them and they will not be built.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

export const REACTIONS_SYSTEM =
	`You decide how a world answers the story going through it. ${HOUSE_STYLE} ` +
	"You are given a story that is already plotted and a map that already exists. You may " +
	"not add a beat, a person or a place. Everything you write hangs off a beat that has " +
	"already been written, chosen by its number in the list.";

/**
 * Ask what the world does about the story, once the story exists.
 *
 * The pass that fills the two holes measured against the hand-written scenarios, where
 * generated worlds scored zero on both: a generated world could not *react* to anything
 * the player did and could not gate anything, so it played as a map with a conversation
 * on it. Both were available in the artifact format the whole time and no pass had ever
 * been asked to produce one.
 *
 * Deliberately last. A trigger is a consequence, and a consequence needs a cause to hang
 * off — asking for these before the arc exists would mean inventing the flag they watch
 * for, which is the one thing that makes a condition unsatisfiable.
 */
export function reactionsPrompt(input: {
	readonly lore: WorldLore;
	readonly beats: readonly { readonly id: string; readonly summary: string }[];
	readonly castles: readonly { readonly name: string; readonly description: string }[];
}): string {
	return [
		`World: ${input.lore.title}. ${input.lore.premise}`,
		`Tone: ${input.lore.tone}.`,
		"",
		"The story, in order:",
		...input.beats.map((beat, index) => `  [${index}] ${beat.id} — ${beat.summary}`),
		"",
		"Write between one and four things the world does after one of those beats. Each is",
		"the world noticing: news travelling, a door standing open that was shut, weather",
		"turning, somebody leaving. Give the beat's number, and either a journal line, a full",
		"screen, or both — anything with neither is dropped.",
		"",
		"These are not beats. Nothing here asks the player to do anything, nothing here opens",
		"a task, and the story does not wait on any of them. They are what the player notices",
		"has changed while they were away.",
		"",
		input.castles.length > 0
			? [
					"There are gates in this world that can be barred:",
					...input.castles.map(
						(castle, index) => `  [${index}] ${castle.name} — ${castle.description}`,
					),
					"",
					"You may bar one. Say which, which beat opens it, and what the player is told while",
					"it stays shut. Nothing the story needs is behind a gate, so this is a place that",
					"becomes available rather than a wall across the plot — bar it only if the story",
					"gives a reason for it to open.",
				].join("\n")
			: "There are no gates in this world to bar, so write no barriers.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

export const READING_SYSTEM =
	"You are handed a finished adventure and asked one question: could somebody play it " +
	"through without getting stuck? You are not a critic and you are not being asked whether " +
	"it is good. Answer only about what would actually stop a player — a scene that does not " +
	"say where to go next, an errand whose object is never mentioned, a character who talks " +
	"as though something has happened that has not. Say nothing about prose quality, and " +
	"invent nothing: if the story is followable, say so and give no notes.";

/**
 * Read a written world back and ask whether it can be followed.
 *
 * The pass the offline validator cannot be. Every check in `validate.ts` is structural — is
 * this flag ever set, can this town be walked to, does this errand name something the world
 * contains — and a world can pass all of them and still be unplayable, because the thing
 * that went wrong is *what the prose says*. The playthrough that prompted this had a sound
 * story where the second scene did not name the town the third was in, and nothing in a
 * static check can see that: there is no rule being broken, only a player left with
 * nowhere to walk.
 *
 * So the mechanical findings go in too, verbatim. They are the parts already known to be
 * wrong, and a reader told about them will not spend its six notes rediscovering them.
 */
export function readingPrompt(input: {
	readonly lore: WorldLore;
	readonly beats: readonly {
		readonly place: string;
		readonly person: string;
		readonly summary: string;
		readonly errand?: string;
		readonly says: readonly string[];
	}[];
	/** What the signposts in this world point at, since they answer the same question. */
	readonly signs: readonly string[];
	/** What the offline checks already found, in their own words. */
	readonly known: readonly string[];
}): string {
	return [
		`World: ${input.lore.title}. ${input.lore.premise}`,
		"",
		"The story, in the order the player meets it:",
		...input.beats.flatMap((beat, index) =>
			[
				`  [${index}] at ${beat.place}, from ${beat.person}: ${beat.summary}`,
				beat.errand ? `        errand: ${beat.errand}` : "",
				...beat.says.map((line) => `        they say: ${line}`),
			].filter(Boolean),
		),
		"",
		input.signs.length > 0
			? ["Signposts stand in this world, and the player can read them:", ...input.signs].join("\n")
			: "There are no signposts in this world.",
		"",
		input.known.length > 0
			? [
					"These are already known to be wrong; do not repeat them:",
					...input.known.map((line) => `  - ${line}`),
				].join("\n")
			: "The offline checks found nothing wrong with it.",
		"",
		"Walk through it as a player who knows nothing. After each scene, ask: do I now know",
		"where to go and who to look for? If the answer is no, that is a note — say which scene",
		"and what is missing. If the answer is yes throughout, give no notes at all.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

export const TREE_SYSTEM =
	`You write dialogue for one character in a small terminal roguelike. ${HOUSE_STYLE} ` +
	"Conversations are choice-only: the player picks from what you offer, so every reply " +
	"you write is a line the player speaks. Keep it short — this is a terminal panel, not a novel.";

export function treePrompt(input: {
	readonly lore: WorldLore;
	readonly site: SiteSpec;
	readonly npc: NpcSpec;
	readonly beat?: {
		readonly summary: string;
		readonly setsFlag: string;
		readonly questName?: string;
	};
	/**
	 * Where the player goes after this scene, when this scene is what sends them.
	 *
	 * The single most useful thing a beat anchor can be told, and it was not being told it.
	 * A conversation is where the player is *standing* when the errand is handed out, so it
	 * is the natural place — and the only reliable one — for "go to Aldermoor and ask for
	 * Lune Harrowgate" to be said. Left out, the model writes a fine scene about the thing
	 * that has just gone wrong and the player walks out of it with no direction.
	 */
	readonly sendsTo?: {
		readonly place: string;
		readonly person?: string;
	};
	/** Flags earlier beats set, which a reply may be gated on. */
	readonly availableFlags: readonly string[];
	/**
	 * Flags a reply *must* be gated on, for a second attempt at a conversation.
	 *
	 * The repair pass's one lever. A fork the scene does not know about is a fork the
	 * player experiences as being ignored — they make the decision, and then everybody
	 * says the same thing either way — and the only fix is prose that knows which way it
	 * went. Asking for a flag to be used is far more reliable than asking again and hoping.
	 */
	readonly insist?: readonly string[];
	/**
	 * What was wrong with the last attempt, in the validator's own words.
	 *
	 * The whole of what the thorough pass adds. A rewrite asked to try again produces
	 * something different; a rewrite told "this scene opens while the player is carrying the
	 * thing and then takes it, so every later hello asks for it again" produces something
	 * *fixed*. Those sentences are already written — they are what the player is shown after
	 * a run — so handing them to the model costs nothing but the tokens.
	 *
	 * Passed through verbatim rather than translated. The messages are written for a reader
	 * and a model is a reader, and any paraphrase here would be a second copy of the
	 * explanation to keep in step with the first.
	 */
	readonly notes?: readonly string[];
}): string {
	const { npc, site } = input;
	return [
		`World: ${input.lore.title}. ${input.lore.premise} Tone: ${input.lore.tone}.`,
		`Place: ${site.name}. ${site.description}`,
		"",
		`You are writing for ${npc.name}, the ${npc.role}.`,
		`Appearance: ${npc.appearance}`,
		`Manner: ${npc.persona}`,
		npc.knows.length > 0 ? `They know: ${npc.knows.join("; ")}` : "",
		site.hooks.length > 0 ? `Locally: ${site.hooks.join("; ")}` : "",
		"",
		input.beat
			? [
					"This person carries a beat of the story:",
					input.beat.summary,
					input.beat.questName ? `It opens the task "${input.beat.questName}".` : "",
					"Write the conversation so that the player learns this by asking, rather than being",
					"told it in the greeting.",
				]
					.filter(Boolean)
					.join("\n")
			: "This person is not part of the main story. Give them something local and true to say.",
		"",
		// Said in one of this character's own lines, because a line of dialogue is the one
		// piece of prose the player cannot miss: they are standing in front of it, reading it,
		// with nothing else on the screen.
		input.sendsTo
			? [
					`When this is done the player should go to ${input.sendsTo.place}${
						input.sendsTo.person ? ` and ask for ${input.sendsTo.person}` : ""
					}.`,
					`One of the lines you write must say so plainly, naming ${input.sendsTo.place} exactly`,
					"like that. Not a hint and not a bearing — the name. A player who leaves this",
					"conversation without it has nowhere to walk, and the story stops there however good",
					"the rest of the scene was.",
				].join("\n")
			: "",
		"",
		input.insist && input.insist.length > 0
			? [
					`This character must have something to say once the player has taken one path rather`,
					`than another. Write an alternative opening hidden behind ${input.insist.join(" or ")},`,
					"and make it a line that only makes sense if that is what happened — an acknowledgement,",
					"a reproach, a change of manner. Without it the decision plays out identically either",
					"way, which reads as the choice not having mattered.",
				].join("\n")
			: input.availableFlags.length > 0
				? `You may hide a reply behind one of these story flags, so it only appears later: ${input.availableFlags.join(", ")}.`
				: "",
		"",
		"Write between two and six nodes. One must be reachable and end the conversation. Every",
		"'goto' must name a node you have written, or be null to end. Give the player a way out of",
		"every node.",
		"",
		"Only use an action if this character would really do it — hand over an object, take payment,",
		"note something down. Most conversations need none.",
		// Last, so it is the freshest thing in the context when the answer is composed, and
		// stated as facts about the previous attempt rather than as a scolding — the previous
		// attempt is not this model's fault and telling it so wastes the instruction.
		input.notes && input.notes.length > 0
			? [
					"",
					"A conversation for this character has been written once already and something was",
					"wrong with it. Fix these, and change nothing else about who they are:",
					...input.notes.map((note) => `  - ${note}`),
				].join("\n")
			: "",
	]
		.filter((line) => line !== "")
		.join("\n");
}
