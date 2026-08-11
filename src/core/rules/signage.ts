import { bearingTo, compassWords } from "./quest-map.js";

/**
 * Signposts: the world telling the player which way to walk.
 *
 * The gap this fills is specific and was costing whole sessions. An open errand gets a
 * bearing on the map, but only once its site is in `discovered` — see `questMarks` — so
 * the one case where a player genuinely does not know where to go is exactly the case
 * with no marker: a town they have never been to. The opening card names the first place
 * and then the player is standing on a road with two ends and nothing to choose between
 * them.
 *
 * A signpost is the diegetic answer, and it is better than a marker for the same reason
 * a signpost is better than a map in life: it is *where the decision is made*. Put one
 * where the road leaves town and the player reads it at the moment they are choosing a
 * direction, not four minutes later when they wonder whether they went the wrong way.
 *
 * The direction and the distance are **never authored**. An arm names a site and the
 * bearing is computed from where that site really is, so a board cannot say east about
 * somewhere west. That is the whole design: prose can lie about a compass and a
 * subtraction cannot, and a signpost that lies is worse than no signpost at all — the
 * player trusts it, walks for two minutes, and stops trusting the game.
 */

export interface SignArm {
	/** The place this arm points at. */
	readonly siteId: number;
	/**
	 * What the board calls it, when that is not simply the site's name.
	 *
	 * For the rare case worth the words: a board that says "the weighing station" where
	 * the site is called "Cull's Weighing Station", or a local name for somewhere the
	 * player has not been told the proper name of yet.
	 */
	readonly label?: string;
}

export interface Sign {
	/** Stable id, for the validator to name and for two signs not to collide. */
	readonly id: string;
	readonly x: number;
	readonly y: number;
	/** Where the arms point, in the order they are read. */
	readonly arms: readonly SignArm[];
	/**
	 * A line of the author's own, read before the arms.
	 *
	 * Where the flavour goes, and where it can do no harm: a note is prose about a place
	 * — "toll paid at the bridge, no exceptions" — and never a direction, because the
	 * directions are derived.
	 */
	readonly note?: string;
}

/**
 * Arms a board can carry before it stops being readable.
 *
 * Three, and the limit is the panel rather than the fiction. What the player is facing is
 * described in two lines of a fixed-height panel, so a fourth destination is a
 * destination that gets cut off — and the arm that gets cut is the one nobody chose to
 * put last for a reason.
 */
export const MAX_SIGN_ARMS = 3;

/**
 * How far, in words a player can act on.
 *
 * Tiles are the engine's unit and mean nothing to somebody holding an arrow key, so this
 * converts to the only measure that matters: whether it is worth setting off now. The
 * thresholds are deliberately coarse, because a wrong number is worse than a vague one.
 *
 * Shared with the opening card, which asks the same question about the first beat.
 */
export function walkTime(tiles: number): string {
	if (tiles < 60) return "a few minutes' walk";
	if (tiles < 250) return "a fair walk";
	return "a long way off";
}

export interface SignWorld {
	/** What a site is called, or undefined if this world has no such site. */
	readonly nameOf: (siteId: number) => string | undefined;
	/** Where it is, or undefined if this world has no such site. */
	readonly positionOf: (siteId: number) => { readonly x: number; readonly y: number } | undefined;
}

/**
 * What a board actually says, worked out against the world it stands in.
 *
 * Composed at read time rather than stored, which is what keeps it honest: the sign is
 * two coordinates and a list of site ids, so moving a town in the recipe moves every
 * arm pointing at it. Nothing to keep in step and nothing that can go stale.
 *
 * An arm naming a site this world does not have is dropped rather than described. A
 * board reading "somewhere: to the north" is worse than a board with one arm on it, and
 * the validator reports the same thing where it can be fixed.
 */
export function signBoard(sign: Sign, world: SignWorld): string {
	const arms: string[] = [];
	for (const arm of sign.arms.slice(0, MAX_SIGN_ARMS)) {
		const at = world.positionOf(arm.siteId);
		const name = arm.label ?? world.nameOf(arm.siteId);
		if (!at || !name) continue;
		// Tiles, not chunks. `bearingTo` is delta arithmetic over any square lattice and
		// the panel wants the distance in the unit the walk is actually measured in.
		const bearing = bearingTo(sign.x, sign.y, at.x, at.y);
		arms.push(
			bearing
				? `${name}: ${compassWords(bearing.compass)}, ${walkTime(bearing.distance)}`
				: // Standing on the place it points at, which a derived sign never is and a
					// hand-written one can be. Said rather than dropped: "you are here" is a
					// useful thing for a board to say.
					`${name}: you are here`,
		);
	}
	const parts = [sign.note?.trim().replace(/\.$/, ""), ...arms].filter(Boolean);
	return parts.length === 0 ? "" : `${parts.join(". ")}.`;
}

/** Signs by the tile they stand on, for the describe path to ask once per keypress. */
export function signIndex(signs: readonly Sign[] | undefined): Map<string, Sign> {
	const index = new Map<string, Sign>();
	for (const sign of signs ?? []) index.set(`${sign.x},${sign.y}`, sign);
	return index;
}

/** Every tile a post stands on, for the generator to stamp. */
export function signTiles(
	signs: readonly Sign[] | undefined,
): readonly { readonly x: number; readonly y: number }[] {
	return (signs ?? []).map((sign) => ({ x: sign.x, y: sign.y }));
}
