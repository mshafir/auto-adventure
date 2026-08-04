import type { Rng } from "../rand/rng.js";
import type { Rect } from "./vec.js";

export interface BspCut {
	/** The line the split was made along, in world coordinates. */
	readonly vertical: boolean;
	readonly at: number;
	readonly within: Rect;
}

export interface BspResult {
	readonly leaves: readonly Rect[];
	/** The cut lines, which become streets when partitioning a settlement. */
	readonly cuts: readonly BspCut[];
}

export interface BspOptions {
	/** A leaf is never split below this size in either axis. */
	readonly minSize: number;
	/** Leaves at or below this size stop splitting even if they could. */
	readonly stopSize?: number;
	readonly maxDepth?: number;
	/** Fraction of the span the cut may wander from centre. */
	readonly jitter?: number;
	/** Width consumed by the cut itself, e.g. a street. */
	readonly cutWidth?: number;
}

/**
 * Recursive binary space partition.
 *
 * Splitting the long axis (rather than a random one) is what keeps plots from
 * degenerating into unusable slivers; the jitter then puts back enough variety
 * that the result does not read as a grid.
 */
export function bspSplit(area: Rect, rng: Rng, options: BspOptions): BspResult {
	const minSize = Math.max(1, options.minSize);
	const stopSize = options.stopSize ?? minSize * 2.2;
	const maxDepth = options.maxDepth ?? 6;
	const jitter = options.jitter ?? 0.2;
	const cutWidth = options.cutWidth ?? 1;

	const leaves: Rect[] = [];
	const cuts: BspCut[] = [];

	const recurse = (r: Rect, depth: number): void => {
		const canSplitH = r.w >= minSize * 2 + cutWidth;
		const canSplitV = r.h >= minSize * 2 + cutWidth;
		const smallEnough = r.w <= stopSize && r.h <= stopSize;

		if (depth >= maxDepth || (!canSplitH && !canSplitV) || (smallEnough && rng.chance(0.6))) {
			leaves.push(r);
			return;
		}

		// Split the longer axis so leaves stay roughly square.
		const vertical = canSplitH && (!canSplitV || r.w >= r.h);

		if (vertical) {
			const span = r.w - cutWidth;
			const centre = span / 2;
			const offset = (rng.float() * 2 - 1) * jitter * span;
			const cut = Math.round(Math.min(span - minSize, Math.max(minSize, centre + offset)));
			cuts.push({ vertical: true, at: r.x + cut, within: r });
			recurse({ x: r.x, y: r.y, w: cut, h: r.h }, depth + 1);
			recurse({ x: r.x + cut + cutWidth, y: r.y, w: r.w - cut - cutWidth, h: r.h }, depth + 1);
		} else {
			const span = r.h - cutWidth;
			const centre = span / 2;
			const offset = (rng.float() * 2 - 1) * jitter * span;
			const cut = Math.round(Math.min(span - minSize, Math.max(minSize, centre + offset)));
			cuts.push({ vertical: false, at: r.y + cut, within: r });
			recurse({ x: r.x, y: r.y, w: r.w, h: cut }, depth + 1);
			recurse({ x: r.x, y: r.y + cut + cutWidth, w: r.w, h: r.h - cut - cutWidth }, depth + 1);
		}
	};

	if (area.w >= 1 && area.h >= 1) recurse(area, 0);
	return { leaves, cuts };
}
