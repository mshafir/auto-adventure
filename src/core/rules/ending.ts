import type { ArcOutline, ScenarioArc } from "./arc.js";
import { type Card, type CardSection, tidyCard } from "./card.js";

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

export function endingCard(arc: ScenarioArc, outline: ArcOutline): Card {
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
