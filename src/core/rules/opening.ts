import type { ScenarioBrief } from "../world/brief.js";
import type { RegionSpec, WorldLore } from "../world/spec.js";
import type { ScenarioArc } from "./arc.js";
import { type Card, tidyCard } from "./card.js";

/**
 * The card the game opens on.
 *
 * Before this, every flavour started the same way: a player standing on a tile with
 * a place name in the corner and no idea what the world was, who they were, or why
 * they had come. All three facts already existed — in the lore, in the brief, in the
 * arc — and none of them were ever said out loud.
 *
 * Assembled rather than written, for two reasons. It must work with no model at
 * all, which rules out asking for a prologue; and every part of it is optional, so
 * a procedural world with no brief still gets an honest card about the country it
 * put the player in, rather than a paragraph of invented motive.
 *
 * The three headings are fixed on purpose. They are the questions a player has in
 * the first ten seconds, in the order they have them.
 */

export interface OpeningInput {
	readonly lore: WorldLore;
	readonly region?: RegionSpec;
	/** The settlement the player woke in, if they woke in one. */
	readonly placeName?: string;
	/** The dominant landscape underfoot, in words. */
	readonly landscape?: string;
	readonly brief?: ScenarioBrief;
	readonly arc?: ScenarioArc;
	/**
	 * Where the story actually begins, if it has one.
	 *
	 * The single most useful sentence on the card and the one that used to be missing:
	 * a premise tells the player what the story is about, and leaves them standing in
	 * a field with no idea which direction anybody is. Resolved by the caller, which
	 * can look the first beat's anchor up in the world; `openingCard` stays pure.
	 */
	readonly start?: {
		readonly place: string;
		readonly person?: string;
		/** Which way it lies from the spawn, in words. */
		readonly bearing?: string;
		/** Roughly how far, in tiles, so "a long walk" can be said honestly. */
		readonly distance?: number;
	};
}

/** Used when nobody said who the player is. Deliberately thin, not blank. */
const DEFAULT_PROTAGONIST =
	"You are a traveller on foot, carrying what you could afford and no letter of introduction.";

export function openingCard(input: OpeningInput): Card {
	return tidyCard({
		id: "opening",
		title: input.lore.title,
		subtitle: input.lore.era,
		sections: [
			{ heading: "Where you are", body: whereYouAre(input) },
			{ heading: "Who you are", body: whoYouAre(input) },
			{ heading: "What brought you here", body: whatBroughtYou(input) },
			{ heading: "Where to start", body: whereToStart(input) },
		],
		footer: "SPACE to begin",
	});
}

/**
 * The country, then the region, then the ground.
 *
 * Widest first: the premise is about the world, the region blurb about a few days'
 * walk, and the landscape about what is actually on screen. Read in that order it
 * zooms in, which is the order that makes the map underneath legible.
 */
function whereYouAre(input: OpeningInput): string {
	const parts = [input.lore.premise];

	if (input.region) {
		const region = input.placeName
			? `You are in ${input.placeName}, in ${input.region.name}.`
			: `This is ${input.region.name}.`;
		parts.push(`${region} ${input.region.blurb}`);
	} else if (input.placeName) {
		parts.push(`You are in ${input.placeName}.`);
	}

	// Only worth saying when there is no region blurb doing the same job better.
	if (input.landscape && !input.region) parts.push(`The country here is ${input.landscape}.`);

	return parts.filter(Boolean).join(" ");
}

function whoYouAre(input: OpeningInput): string {
	const protagonist = input.brief?.protagonist?.trim();
	if (!protagonist) return DEFAULT_PROTAGONIST;
	// The brief is written in the third person — "a timber-tallier walking the road
	// out of season" — and the card is addressed to the player, so it is turned
	// around here rather than asking authors to write it twice.
	return `You are ${protagonist.replace(/^(you are|a player who is)\s+/i, "")}.`.replace(
		/\.\.$/,
		".",
	);
}

/**
 * The errand, if there is one.
 *
 * An arc premise is the strongest answer and a scenario always has one. A live world
 * has only the brief's storyline, which is the same thing written earlier. A
 * procedural world has neither, and says so — an invented motive would be a lie the
 * game then has to keep, and there is no arc to keep it with.
 */
function whatBroughtYou(input: OpeningInput): string {
	const premise = input.arc?.premise?.trim();
	if (premise) return premise;

	const storyline = input.brief?.storyline?.trim();
	if (storyline) return capitalise(storyline.replace(/^the player is\s+/i, "You are "));

	return "Nothing in particular, and nobody is expecting you. Whatever you end up doing here, you will be the one who decided to.";
}

/**
 * The first concrete instruction.
 *
 * Everything above this is context; this is the only line that answers "so what do I
 * do now". Omitted rather than invented when there is no arc — a live or procedural
 * world has nobody in particular waiting, and pointing at a random town would be a
 * lie the game cannot keep.
 */
function whereToStart(input: OpeningInput): string {
	const start = input.start;
	if (!start) return "";

	const who = start.person ? `Ask for ${start.person}.` : "";
	const how = start.bearing
		? `${start.place} lies ${start.bearing}${distanceHint(start.distance)}.`
		: `Make for ${start.place}.`;

	return [how, who, "Open errands are marked on the map with a bearing."].filter(Boolean).join(" ");
}

/**
 * How far, in words a player can act on.
 *
 * Tiles are the engine's unit and mean nothing to somebody holding an arrow key, so
 * this converts to the only measure that matters — whether it is worth setting off
 * now. The thresholds are deliberately coarse; a wrong number would be worse than a
 * vague one.
 */
function distanceHint(tiles: number | undefined): string {
	if (tiles === undefined) return "";
	if (tiles < 60) return ", a few minutes' walk";
	if (tiles < 250) return ", a fair walk";
	return ", a long way off";
}

function capitalise(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return trimmed;
	const ended = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
	return ended.charAt(0).toUpperCase() + ended.slice(1);
}
