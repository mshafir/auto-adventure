/**
 * What the player asked this world to be about.
 *
 * A brief is *intent*, never geometry. Nothing here can move a coastline or
 * place a town — the engine still decides what exists, exactly as it does with
 * no brief at all. The brief only reaches the prompts that name and populate
 * what the engine already built, which is why an unsatisfiable brief produces a
 * differently-flavoured world rather than a broken one.
 *
 * It lives in `core` for the same reason `WorldLore` does: it is persisted in
 * `GameState`, and core cannot depend on anything above it.
 */

/**
 * How long the scenario is meant to last.
 *
 * Meaningful only for pre-generated scenarios, where it sets both the number of
 * story beats and the radius of the authored footprint — in a bounded world
 * those are the same knob. A live world is unbounded and has no arc, so it
 * records the field and ignores it.
 */
export type Duration = "short" | "medium" | "long";

export interface ScenarioBrief {
	/** Freeform intent, used close to verbatim. The main knob. */
	readonly premise?: string;
	readonly setting?: string;
	readonly storyline?: string;
	readonly tone?: string;
	readonly protagonist?: string;
	/** Things to keep out — genres, tropes, subject matter. */
	readonly avoid?: string;
	readonly duration?: Duration;
}

const DURATIONS: readonly Duration[] = ["short", "medium", "long"];

export function isDuration(value: string): value is Duration {
	return (DURATIONS as readonly string[]).includes(value);
}

/**
 * Whether a brief carries any instruction at all.
 *
 * An all-blank brief must be indistinguishable from no brief: it has to leave
 * the default prompts exactly as they were, or every existing world would start
 * generating differently the day this shipped.
 */
export function isBriefEmpty(brief: ScenarioBrief | undefined): boolean {
	if (!brief) return true;
	// Trimmed, because a field holding only whitespace carries no instruction —
	// and a prompt that reshapes itself around one would reword the premise of
	// every world whose brief was a stray space.
	return !(
		brief.premise?.trim() ||
		brief.setting?.trim() ||
		brief.storyline?.trim() ||
		brief.tone?.trim() ||
		brief.protagonist?.trim() ||
		brief.avoid?.trim() ||
		brief.duration
	);
}

/**
 * Drop blank fields and trim the rest, returning undefined for a brief with
 * nothing in it.
 *
 * Every source of a brief is loose — environment variables, a text field in the
 * launcher, JSON from an artifact — so `SCENARIO_TONE=""` and a field the player
 * tabbed past must both read as absent rather than as an empty instruction.
 */
export function normalizeBrief(brief: ScenarioBrief | undefined): ScenarioBrief | undefined {
	if (!brief) return undefined;

	const next: {
		premise?: string;
		setting?: string;
		storyline?: string;
		tone?: string;
		protagonist?: string;
		avoid?: string;
		duration?: Duration;
	} = {};

	const text = (value: string | undefined): string | undefined => {
		const trimmed = value?.trim();
		return trimmed ? trimmed : undefined;
	};

	const premise = text(brief.premise);
	if (premise) next.premise = premise;
	const setting = text(brief.setting);
	if (setting) next.setting = setting;
	const storyline = text(brief.storyline);
	if (storyline) next.storyline = storyline;
	const tone = text(brief.tone);
	if (tone) next.tone = tone;
	const protagonist = text(brief.protagonist);
	if (protagonist) next.protagonist = protagonist;
	const avoid = text(brief.avoid);
	if (avoid) next.avoid = avoid;
	if (brief.duration) next.duration = brief.duration;

	return isBriefEmpty(next) ? undefined : next;
}
