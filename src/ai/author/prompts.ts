import type { ScenarioBrief } from "../../core/world/brief.js";
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

const HOUSE_STYLE =
	"Write like a good tabletop GM: concrete, specific, unsentimental. " +
	"Prefer one telling detail to three adjectives. Never mention game mechanics, " +
	"tiles, chunks, seeds, or that this is generated. No markdown, no lists in prose fields.";

export const ARC_SYSTEM =
	`You plot the story of a small terminal roguelike. ${HOUSE_STYLE} ` +
	"You are given a world that already exists: its towns, their sizes, who lives in " +
	"them and how far apart they are. Place a story through it. You may not invent a " +
	"settlement, move one, or add a person — choose from what is listed.";

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
 * About one per three beats, floored at one. Fewer than that and the map is scenery
 * between conversations; many more and the main line stops being findable among them.
 * The count is asked for explicitly because a range was ignored: every generated arc came
 * back with none at all while `optional` sat in the schema, documented and unused.
 */
function optionalWanted(beats: number): number {
	return Math.max(1, Math.round(beats / 3));
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
		"The last beat should end the story, not open another door.",
		"",
		// Both of these were available before and neither was ever used: every generated
		// world came back with zero side errands and zero hidden things, because "you may"
		// reads as "you need not" and the straight line is always the easier thing to write.
		// A story of nothing but main beats is a story of walking between conversations.
		`Two of these are required. ${optionalWanted(input.beats)} of those ${input.beats} beats must`,
		"be side errands marked optional, and at least one beat must hide something to find:",
		"",
		"  optional  A side errand, off the main line. The story can finish with it still open,",
		"            so this is where a piece of the world that is worth finding but not on the",
		"            way belongs. It is what makes the map worth leaving the road for.",
		"  find      Something hidden. Name it, say which kind of building at that settlement",
		"            it is in, and the player has to go and get it before the beat closes.",
		"            A story where nothing is ever searched for is a story with no objects in it.",
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
	]
		.filter((line) => line !== "")
		.join("\n");
}
