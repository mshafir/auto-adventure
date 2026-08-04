/**
 * A full screen of prose, shown once.
 *
 * The game drops the player onto a tile with a two-line status bar, which tells
 * them where they are and nothing about why they are there. A card is the one
 * place allowed to simply *say* things: this is the country, this is you, this is
 * what you were doing when the game started.
 *
 * Two properties make it worth being state rather than a one-off screen in the UI.
 * It is raised by a `DomainEffect`, so anything that can already change the game
 * can raise one — a story beat, an arrival, a discovery — without the UI knowing
 * what occasions exist. And it is shown *once*: the id becomes a flag, so a card
 * survives a reload by never appearing again, which is the behaviour a player
 * expects from a thing they have already read.
 *
 * Deliberately not a dialogue. A conversation has a speaker, a memory and a
 * disposition; this has none of those, and modelling it as an NPC with no name
 * would put junk in `state.npcs` forever.
 */

export interface CardSection {
	/** Short label. Rendered as a rule above the body, so keep it to a few words. */
	readonly heading: string;
	readonly body: string;
}

export interface Card {
	/**
	 * Stable identity, and the reason a card cannot be shown twice.
	 *
	 * Becomes `card:<id>` in the flags, which is persisted — so "the opening" is
	 * a fact about the save, not about the process.
	 */
	readonly id: string;
	readonly title: string;
	readonly subtitle?: string;
	readonly sections: readonly CardSection[];
	/** Overrides the default "press SPACE" hint, for a card that ends something. */
	readonly footer?: string;
}

/** The flag that records a card as read. */
export function cardKey(id: string): string {
	return `card:${id}`;
}

/** Whether this card has already been shown in this world. */
export function cardSeen(flags: Readonly<Record<string, unknown>>, id: string): boolean {
	return Boolean(flags[cardKey(id)]);
}

/**
 * Drop sections with nothing in them.
 *
 * Every producer of a card assembles it from optional parts — a brief that may
 * say nothing about the protagonist, a world with no story yet — and a heading
 * with an empty body reads as a bug rather than as silence.
 */
export function tidyCard(card: Card): Card {
	const sections = card.sections.filter((section) => section.body.trim().length > 0);
	return { ...card, sections };
}
