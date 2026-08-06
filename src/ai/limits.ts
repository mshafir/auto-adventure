import { z } from "zod";

/**
 * Caps that trim rather than refuse.
 *
 * Every field a model fills in has a budget: a name that has to fit a label, four lore
 * lines because a fifth is never read, two hooks because a third crowds the menu. Those
 * budgets were written as `z.string().max(60)` and `z.array(x).max(2)`, which validate
 * the answer and throw the whole thing away when it is one item over.
 *
 * That turned out to be the dominant failure mode of the authoring pipeline, and it is
 * worth being precise about how bad it was: sampling the region and site passes, *every*
 * failure was a `too_big` — six ambient lines against a cap of five, three hooks against
 * a cap of two, one `knows` line at 170 characters against a cap of 160. Not one was a
 * malformed or nonsensical answer. Roughly half of all calls were discarded, and since a
 * discarded call falls back to the deterministic spec, the visible symptom was not an
 * error but a *thin world*: unnamed regions, and — because the arc is plotted only from
 * settlements that have people in them — no story at all.
 *
 * A budget is not a correctness property. Nothing downstream breaks if a list is shorter
 * than the model offered, so the cap belongs on the way in rather than as a veto: take
 * the first `n`, trim the overlong string, keep the answer. `min` constraints, enums and
 * required fields are untouched — those *are* correctness, and an answer that misses one
 * really is unusable.
 *
 * The prompts still state the limits. Asking for four and taking the first four of five is
 * a much better trade than asking for four, being given five, and using none of them.
 */

/**
 * A string cut to length at a word boundary where there is one nearby.
 *
 * Mid-word truncation reads as corruption — "the man who kn" looks like a bug in a way
 * that a slightly short sentence does not — so the cut prefers the last space in the final
 * fifth of the budget, and falls back to a hard slice when there is no space to use.
 */
export function cappedText(limit: number) {
	return z.string().transform((value) => trimTo(value, limit));
}

export function trimTo(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const hard = value.slice(0, limit);
	const space = hard.lastIndexOf(" ");
	return (space > limit * 0.8 ? hard.slice(0, space) : hard).trimEnd();
}

/** A list cut to length, keeping the first `limit` entries. */
export function cappedList<T extends z.ZodTypeAny>(item: T, limit: number) {
	return z.array(item).transform((value) => value.slice(0, limit));
}

/**
 * An identifier put into the shape the engine keys on, rather than refused for its case.
 *
 * The other half of the same story as the caps above, and it cost the entire dialogue
 * pass: asked for "a lower-case slug", the model reliably writes `ask_about_the_siege` or
 * `AskAboutSiege`, and a `.regex()` threw away every conversation in the world over it.
 * Nothing about a node id is meaningful except that it is stable and that the references
 * to it match, so normalising is strictly better than rejecting.
 *
 * The catch, and the reason this is one shared function rather than a tidy-up at each
 * field: `goto`, `entry`, `revisit` and `partOf` all *point at* ids, so they have to be
 * put through exactly the same transformation or a normalised node becomes unreachable
 * from an un-normalised reference. Referential integrity survives because the mapping is
 * deterministic and applied everywhere.
 */
export function slugText(limit: number) {
	return z.string().transform((value) => toSlug(value, limit));
}

export function toSlug(value: string, limit: number): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, limit)
		.replace(/-+$/g, "");
	// Never empty and never leading with a dash, which is what the pattern insisted on.
	return /^[a-z0-9]/.test(slug) ? slug : `n${slug}`;
}

/**
 * A whole number pulled back inside its range.
 *
 * The same argument as the others, and the same failure: a disposition of 70 against a
 * ceiling of 60 is a character who is *very* friendly, and throwing away the town they
 * live in over it helps nobody. Rounded as well as clamped, because a model asked for an
 * integer occasionally offers 3.5.
 */
export function cappedInt(low: number, high: number) {
	return z.number().transform((value) => Math.min(high, Math.max(low, Math.round(value))));
}
