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
	].join("\n");
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
