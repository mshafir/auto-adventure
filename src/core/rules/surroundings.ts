import type { QuestObjectiveKind } from "./state.js";

/**
 * What actually exists near a conversation.
 *
 * One value, two consumers, and that is the point. The dialogue prompt renders it
 * so an NPC can only mention things the engine really built, and the action
 * boundary resolves quest targets against it so a quest cannot be opened against
 * something that was never placed. Previously an NPC was told its town's *name*
 * and *description* and nothing else physical, so it furnished a plausible
 * village from tone alone — asking the player to fetch timber from a mill that
 * the generator had never put anywhere.
 *
 * Lives in `core/rules` because the quest verifier reads the same names, and core
 * cannot depend on the engine that assembles it.
 *
 * Deliberately a plain description rather than a live query: it is built once per
 * turn from the engine, so the model and the resolver see exactly the same world,
 * and a test can hand-write one.
 */
export interface Surroundings {
	/** The settlement this conversation is happening in, by name. */
	readonly place?: string | undefined;
	/** Buildings the settlement generator actually placed here. */
	readonly buildings: readonly SurroundingBuilding[];
	/** Other people at this site, who the player could be sent to. */
	readonly people: readonly SurroundingPerson[];
	/** Other named places within reach — neighbouring settlements and landmarks. */
	readonly places: readonly string[];
	/**
	 * Item names known to exist: on sale nearby, already carried, or findable.
	 *
	 * Used to reject a `have` objective naming something unobtainable. Extend this
	 * rather than hardcoding a catalogue anywhere, so authored content can add to
	 * the set without touching the resolver.
	 */
	readonly items: readonly string[];
}

export interface SurroundingBuilding {
	readonly name: string;
	readonly kind: string;
}

export interface SurroundingPerson {
	readonly name: string;
	readonly role: string;
}

export const EMPTY_SURROUNDINGS: Surroundings = {
	buildings: [],
	people: [],
	places: [],
	items: [],
};

/**
 * Words that carry no identity, so "the mill" and "Mill" are the same request.
 */
const NOISE = new Set(["the", "a", "an", "of", "at", "in", "on", "to", "and", "old"]);

/** Significant lowercase words in a name, punctuation and articles removed. */
function significantWords(name: string): string[] {
	return name
		.toLowerCase()
		.replace(/['’]/g, "")
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0 && !NOISE.has(word));
}

/**
 * Loose name comparison, because both sides of it come from prose.
 *
 * An NPC says "the mill" for a building the director named "Harrowmill Mill", so
 * the two have to be able to meet. Matching is on *words*, not on substrings:
 * plain containment fails on exactly the realistic case, because the article in
 * "the mill" is not present in "Harrowmill Mill".
 *
 * Substring matching would also be actively wrong in the other direction — "mill"
 * is a substring of "Millgate Barracks", and resolving a milling errand to the
 * barracks sends the player somewhere the NPC never meant. One name matches
 * another when the significant words of one are all present in the other.
 */
export function namesMatch(a: string, b: string): boolean {
	const left = significantWords(a);
	const right = significantWords(b);
	if (left.length === 0 || right.length === 0) return false;

	const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
	const haystack = new Set(longer);
	return shorter.every((word) => haystack.has(word));
}

/**
 * The canonical name for something an NPC referred to, or `undefined`.
 *
 * Returns the *world's* spelling rather than the model's, so a quest log entry
 * and the place label agree. Exact matches win over partial ones: with buildings
 * called "Mill" and "Millgate Barracks", asking for "Mill" must not resolve to
 * the barracks just because it was listed first.
 */
export function resolveName(requested: string, candidates: readonly string[]): string | undefined {
	const wanted = requested.trim().toLowerCase();
	if (!wanted) return undefined;

	for (const candidate of candidates) {
		if (candidate.trim().toLowerCase() === wanted) return candidate;
	}
	let best: string | undefined;
	for (const candidate of candidates) {
		if (!namesMatch(requested, candidate)) continue;
		// Prefer the shortest partial match: it is the most specific reading of a
		// vague request, and it is stable regardless of listing order.
		if (best === undefined || candidate.length < best.length) best = candidate;
	}
	return best;
}

/**
 * The world's own name for what a quest objective asked for, or `undefined`.
 *
 * The single answer to "can this errand be given here?", so the dialogue boundary
 * and the offline scenario validator cannot disagree about it. They used to: the
 * validator matched place names by substring, which `namesMatch` above explains is
 * actively wrong — "mill" is a substring of "Millgate Barracks". A `reach: "mill"`
 * objective therefore passed authoring and could never be completed, because
 * `verifyQuests` resolves the same name by words and would never match it.
 *
 * Returns the canonical spelling so a quest log entry and the place label agree.
 */
export function resolveObjectiveTarget(
	kind: QuestObjectiveKind,
	requested: string,
	surroundings: Surroundings | undefined,
	carried: readonly string[] = [],
): string | undefined {
	// Without surroundings there is nothing to check against, so the target passes
	// through. Keeps every existing caller and test working unchanged, and means a
	// missing wiring degrades to the old behaviour rather than to no quests at all.
	if (!surroundings) return requested;

	switch (kind) {
		// A flag is the giver's own bookkeeping and names nothing in the world.
		case "flag":
			return requested;

		case "reach":
			return resolveName(requested, [
				...(surroundings.place ? [surroundings.place] : []),
				...surroundings.places,
				...surroundings.buildings.map((building) => building.name),
			]);

		case "talk":
			return resolveName(
				requested,
				surroundings.people.map((person) => person.name),
			);

		case "have":
			// Anything already carried counts: somebody may ask for a thing the player
			// picked up in a place this conversation knows nothing about.
			return resolveName(requested, [...surroundings.items, ...carried]);
	}
}
