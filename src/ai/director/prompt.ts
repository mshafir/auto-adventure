import { normalizeBrief, type ScenarioBrief } from "../../core/world/brief.js";
import type { RegionContext, SiteContext } from "../../core/world/context.js";
import type { RegionSpec, WorldLore } from "../../core/world/spec.js";

/**
 * The prompts, and the one idea they all encode: the model is *naming and
 * populating a place the engine already built*.
 *
 * Nothing here asks the model where a town should be, how large it is, or what
 * the terrain looks like — those are facts, stated up front, and the model's job
 * is to make them mean something. That is what makes the output cheap, fast, and
 * impossible to contradict.
 */

const HOUSE_STYLE =
	"Write like a good tabletop GM: concrete, specific, unsentimental. " +
	"Prefer one telling detail to three adjectives. Never mention game mechanics, " +
	"tiles, chunks, seeds, or that this is generated. No markdown, no lists in prose fields.";

export const LORE_SYSTEM = `You are the loremaster for a small terminal roguelike. ${HOUSE_STYLE}`;

/**
 * The player's intent, as prompt lines.
 *
 * Deliberately terse. This rides along on the region and site calls, which are
 * the high-volume ones, so anything restated here is paid for on every
 * settlement in the world.
 */
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

/**
 * The default premise, used when nobody asked for anything in particular.
 *
 * Kept as the fallback rather than as a base the brief is layered onto: a brief
 * asking for high sorcery should not have to argue with "low-magic".
 */
const DEFAULT_PREMISE = [
	"It should be a low-magic, lived-in place at a moment of quiet change — the kind of setting",
	"where a traveller on foot is the natural protagonist.",
].join(" ");

/**
 * Every entry point here normalises its own brief rather than trusting the
 * caller. Briefs arrive from environment variables, a launcher text field and
 * artifact JSON, and a whitespace-only field from any of them must read as
 * silence — otherwise it reformats the prompt without adding an instruction.
 */
export function lorePrompt(raw?: ScenarioBrief): string {
	const brief = normalizeBrief(raw);
	if (!brief) {
		return [
			"Invent the premise for a new world.",
			DEFAULT_PREMISE,
			"Keep it small enough that a village blacksmith would plausibly have an opinion about it.",
		].join(" ");
	}

	// The scale guidance survives a brief because it is about what this game can
	// render, not about genre: an infinite walkable world seen from a single
	// traveller's eye level. The premise it replaces was a taste default.
	return [
		"Build the premise for a new world from the author's brief below. Follow it closely — where",
		"it is silent, invent; where it is specific, obey.",
		"",
		...briefLines(brief),
		"",
		"Whatever the brief asks for, keep it small enough that a village blacksmith would plausibly",
		"have an opinion about it, and keep a traveller on foot a natural protagonist.",
	].join("\n");
}

export const REGION_SYSTEM = `You name and characterise regions of a world. ${HOUSE_STYLE}`;

/**
 * What to restate on the per-region and per-site calls.
 *
 * Not the whole brief: the premise and setting are already inside `lore`, which
 * was generated from them, and repeating them invites the model to re-derive the
 * world instead of building on it. Only the parts that steer *this* call carry
 * forward — the storyline, because hooks and ambient lines should point at it,
 * and the constraints, because they are easy to drift out of.
 */
function intentBlock(raw: ScenarioBrief | undefined): string[] {
	const brief = normalizeBrief(raw);
	if (!brief) return [];
	const lines: string[] = [];
	if (brief.storyline) lines.push(`- Storyline in play: ${brief.storyline}`);
	if (brief.tone) lines.push(`- Hold this tone: ${brief.tone}`);
	if (brief.avoid) lines.push(`- Avoid: ${brief.avoid}`);
	if (lines.length === 0) return [];
	return ["", "Author's intent:", ...lines];
}

export function regionPrompt(
	lore: WorldLore,
	context: RegionContext,
	brief?: ScenarioBrief,
): string {
	return [
		`World: ${lore.title}. ${lore.premise}`,
		`Era: ${lore.era}. Tone: ${lore.tone}.`,
		`Known factions: ${lore.factions.join(", ")}.`,
		"",
		"Describe one region of it. The terrain is already fixed:",
		`- Dominant landscape: ${context.biomeName}.`,
		`- Also present: ${context.biomes.join(", ")}.`,
		context.settlementKinds.length > 0
			? `- Settlements here: ${context.settlementKinds.join(", ")}.`
			: "- No settlements; this is empty country.",
		...intentBlock(brief),
		"",
		"Name it and say who lives there. The ambient lines are shown one at a time as the player",
		"walks; they should be short, second-person, and specific to this landscape.",
	].join("\n");
}

export const SITE_SYSTEM =
	`You populate settlements in a world. ${HOUSE_STYLE} ` +
	"You are given a place the engine has already laid out. Do not describe its layout, " +
	"its size, or where its buildings are — those are decided. Name it, choose which " +
	"buildings occupy the plots available, and give it people.";

export function sitePrompt(
	lore: WorldLore,
	region: RegionSpec,
	context: SiteContext,
	brief?: ScenarioBrief,
): string {
	const neighbours =
		context.neighbours.length > 0
			? context.neighbours.map((n) => `a ${n.kind} to the ${n.bearing}`).join(", ")
			: "nothing for a day's walk in any direction";

	return [
		`World: ${lore.title}. ${lore.premise} Tone: ${lore.tone}.`,
		`Region: ${region.name} — ${region.blurb} Culture: ${region.culture}.`,
		region.factionName ? `Locally aligned with ${region.factionName}.` : "",
		"",
		"The place:",
		`- Kind: ${context.kind} (importance ${context.importance} of 5).`,
		`- Landscape: ${context.biomeName}, ${context.terrain} ground.`,
		context.coastal ? "- Close to the sea." : "",
		context.nearRiver ? "- A river runs through or beside it." : "",
		context.roadCount === 0
			? "- No road reaches it."
			: context.roadCount === 1
				? "- One road reaches it; it is the end of the line."
				: `- ${context.roadCount} roads meet here.`,
		`- Nearby: ${neighbours}.`,
		`- Room for about ${context.buildingBudget} buildings.`,
		...intentBlock(brief),
		"",
		`Give exactly ${context.buildingBudget} structures, ordered by how much they matter to the`,
		"place. Importance decides who gets the good plots when there are fewer than requested,",
		"so put the landmark buildings first and fill the rest with houses. Only shops and inns",
		"get signText.",
		"",
		`Give ${Math.min(4, Math.max(1, Math.round(context.buildingBudget / 2)))} people. Each stands`,
		"outdoors where the player can find them: shopkeepers on their doorstep, guards at the gate,",
		"idlers at the well or a bench. 'knows' is what they will actually tell the player if asked —",
		"rumours, prices, directions, grudges. Make at least one of them know something the player",
		"could act on.",
	]
		.filter(Boolean)
		.join("\n");
}
