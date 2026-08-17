/**
 * How far apart two places are, in words an author can plan with.
 *
 * A number of tiles is not a decision. "Ninety-four" tells an author nothing about whether
 * the walk between two towns is a beat of the story or an interruption in it, so every
 * placement decision was being made against a number whose meaning nobody had written down —
 * and the first world built this way put its two towns forty-seven tiles apart, which is not
 * a journey between two places but two halves of one place with a field in the middle.
 *
 * The bands are calibrated against walking, because that is the only thing the player does
 * between them. A step is one command and a player at the keyboard manages three or four a
 * second, so a hundred tiles is around half a minute of holding a key with the map sliding
 * past. That is the unit these are built from.
 */

export type Reach = "adjacent" | "neighbouring" | "a walk" | "a journey" | "far";

export interface Band {
	readonly reach: Reach;
	/** Inclusive floor, in tiles. */
	readonly from: number;
	/** What it is like to walk, and when to want it. */
	readonly means: string;
}

/**
 * The bands, from nearest out.
 *
 * `adjacent` is the one to design away from: two places this close read as one, whatever
 * their names say, and a beat at each end is two beats in the same room. Everything from
 * `neighbouring` up is a real distance, and which of them to want is a question about the
 * story rather than about the map — a story of four beats wants most of its legs to be
 * walks, with at most one journey in it.
 */
export const BANDS: readonly Band[] = [
	{
		reach: "adjacent",
		from: 0,
		means: "the same place with a field in it. Two beats here are one scene",
	},
	{
		reach: "neighbouring",
		from: 70,
		means:
			"the next village over, in sight of where you came from. Fine for an errand, thin for a leg of the story",
	},
	{
		reach: "a walk",
		from: 140,
		means:
			"half a minute of road with something to see on it. Where most legs of a story want to be",
	},
	{
		reach: "a journey",
		from: 300,
		means: "somewhere you set out for. Worth it once in a story, tedious twice",
	},
	{
		reach: "far",
		from: 550,
		means:
			"the other end of the world. Put something at the halfway point or nobody will make it twice",
	},
];

/** The shortest walk that is a walk. Below this, two places are one place. */
export const TOO_CLOSE = 70;

export function reachOf(tiles: number): Band {
	let found = BANDS[0] as Band;
	for (const band of BANDS) {
		if (tiles >= band.from) found = band;
	}
	return found;
}

/** `"a walk (168)"` — the band and the number, because an author needs both. */
export function describeReach(tiles: number): string {
	return `${reachOf(tiles).reach} (${Math.round(tiles)})`;
}

export function tilesBetween(
	a: { readonly x: number; readonly y: number },
	b: { readonly x: number; readonly y: number },
): number {
	return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}
