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
		"Four things you may use, none of them required. Use at most one fork, and use each",
		"only where it makes the story better than a straight line would:",
		"",
		"  optional  A side errand. The story can finish with it still open, so this is where",
		"            a piece of the world that is worth finding but not on the way belongs.",
		"  partOf    Give a beat the id of an earlier one, and it becomes a step of it: the",
		"            earlier errand cannot close until this one does. Two or three steps under",
		"            one job reads far better than three unrelated jobs.",
		"  branch    Two beats with the same branch name are alternatives. Taking one bars the",
		"            other for good. Use it for a decision the player should not be able to",
		"            take back — who to tell, which side to take — and write an ending for",
		"            each arm.",
		"  find      Something hidden. Name it, say which kind of building at that settlement",
		"            it is in, and the player has to go and get it before the beat closes.",
		"",
		"If you use a branch, write one ending per arm: name the branch group and the beat, and",
		"say what the world looks like afterwards. Otherwise write no endings at all.",
	].join("\n");
}

export const SHAPE_SYSTEM =
	"You choose what kind of country a story happens in. You are given a brief and nothing " +
	"else. Answer with the five settings and one sentence saying why. Do not write prose, " +
	"do not name places, and do not describe a plot.";

/**
 * Ask what kind of world the brief wants, before the world exists.
 *
 * The one authoring decision that has to be made *first*: the survey runs against a
 * world, so the world has to be chosen before there is anything to survey. Deliberately
 * five coarse settings rather than a recipe — a model handed `seaLevel` will write
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
		input.availableFlags.length > 0
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
