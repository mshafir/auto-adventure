import type { ArcEnding, ArcOutline, ScenarioArc } from "./arc.js";
import { type Card, type CardSection, tidyCard } from "./card.js";
import { evaluate } from "./condition.js";
import type { GameState } from "./state.js";

/**
 * The card a finished story closes on.
 *
 * The counterpart to `openingCard`, written for the same reason and after the same
 * complaint. A player reached the end of a scenario, saw `Completed: Find the ledger
 * in Harrowmere` as the last line of their log, and asked whether that was it. It
 * was. Nothing said so.
 *
 * The game *knew*: every beat reached, every errand closed. It reported that as `3/3`
 * in a rule label and left the player to do the arithmetic and still not be sure. An
 * ending is not a status; it is a thing that should be said out loud, on the screen
 * that a story opened on.
 *
 * Assembled when nobody wrote one, so every scenario gets closure rather than only
 * the well-authored ones. An authored `arc.ending` replaces the body entirely, which
 * is how a story gets a real last page.
 */

/** The card's id, so it cannot be shown twice and cannot collide with a beat's. */
export const ENDING_CARD_ID = "arc:end";

/**
 * A forked ending's card id.
 *
 * Namespaced by the ending's own id rather than sharing {@link ENDING_CARD_ID}, so the
 * "read once" flag is per outcome. Sharing it would be a real bug rather than a tidiness
 * point: two playthroughs of the same save file cannot happen, but a story whose
 * conditions shift — a reputation crossing back over a threshold before the card is
 * dismissed — would otherwise find the ending already marked read and show nothing.
 */
export function forkedEndingCardId(id: string): string {
	return `arc:end:${id}`;
}

export function endingCard(arc: ScenarioArc, outline: ArcOutline, state?: GameState): Card {
	// A forked outcome first: it is the most specific thing an author can say about how
	// the story ended, and the whole reason a branch is worth taking.
	const forked = state ? pickEnding(arc, state) : undefined;
	if (forked) {
		return tidyCard({
			id: forkedEndingCardId(forked.id),
			title: forked.title,
			...(forked.subtitle ? { subtitle: forked.subtitle } : {}),
			sections: forked.sections,
			footer: "SPACE to go on",
		});
	}

	const authored = arc.ending;
	if (authored) {
		return tidyCard({
			id: ENDING_CARD_ID,
			title: authored.title,
			...(authored.subtitle ? { subtitle: authored.subtitle } : {}),
			sections: authored.sections,
			footer: "SPACE to go on",
		});
	}

	return tidyCard({
		id: ENDING_CARD_ID,
		title: arc.title,
		subtitle: "the story is told",
		sections: defaultSections(arc, outline),
		footer: "SPACE to go on",
	});
}

/**
 * Which of several outcomes this playthrough earned.
 *
 * First match in author order, because an author writing "the grim one if the mill
 * burned, otherwise the quiet one" is expressing precedence — and a scoring rule would
 * make them invent numbers to say something they have already said by ordering. An
 * ending with no condition always matches, which is how the last entry becomes the
 * catch-all.
 */
export function pickEnding(arc: ScenarioArc, state: GameState): ArcEnding | undefined {
	return arc.endings?.find((ending) => evaluate(ending.when, state));
}

/**
 * A last page for a story that did not write one.
 *
 * Made of what the player did rather than of invented prose: the premise they set
 * out on, the steps they actually finished, and — plainly, because this is the
 * question being answered — that nothing is waiting on them. Inventing an epilogue
 * would be putting words in an author's mouth about a story this file has never read.
 */
function defaultSections(arc: ScenarioArc, outline: ArcOutline): CardSection[] {
	const steps = outline.steps.map((step) => step.label);
	return [
		{ heading: "What you set out to do", body: arc.premise },
		{
			heading: "What you did",
			body: steps.length > 0 ? steps.map((label) => `— ${label}`).join("\n") : "",
		},
		{
			heading: "And now",
			body:
				"That is the whole of it. Nothing is waiting on you, and nobody is expecting you " +
				"anywhere. The road is still there, and so is the weather.",
		},
	];
}
