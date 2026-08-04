import type { Rect } from "./vec.js";

export interface FloodResult {
	/** Component id per cell, 0 = impassable, 1..n = component. */
	readonly labels: Uint16Array;
	/** Cell count per component, indexed by component id (index 0 unused). */
	readonly sizes: readonly number[];
	readonly componentCount: number;
}

/**
 * Label every connected passable region in a rectangle.
 *
 * Iterative with an explicit stack rather than recursion: a 64x64 chunk of open
 * ground is 4096 cells deep in the worst case, which is enough to blow the call
 * stack on some runtimes.
 */
export function labelComponents(
	bounds: Rect,
	passable: (x: number, y: number) => boolean,
	diagonal = false,
): FloodResult {
	const { x: bx, y: by, w, h } = bounds;
	const labels = new Uint16Array(w * h);
	const sizes: number[] = [0];
	const stack: number[] = [];

	const steps: readonly (readonly [number, number])[] = diagonal
		? [
				[0, -1],
				[1, 0],
				[0, 1],
				[-1, 0],
				[1, -1],
				[1, 1],
				[-1, 1],
				[-1, -1],
			]
		: [
				[0, -1],
				[1, 0],
				[0, 1],
				[-1, 0],
			];

	let next = 1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const seed = y * w + x;
			if (labels[seed] !== 0 || !passable(bx + x, by + y)) continue;

			const id = next++;
			let count = 0;
			labels[seed] = id;
			stack.push(seed);

			while (stack.length > 0) {
				const cell = stack.pop() as number;
				count++;
				const cx = cell % w;
				const cy = (cell - cx) / w;
				for (const [dx, dy] of steps) {
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const ni = ny * w + nx;
					if (labels[ni] !== 0 || !passable(bx + nx, by + ny)) continue;
					labels[ni] = id;
					stack.push(ni);
				}
			}
			sizes[id] = count;
		}
	}

	return { labels, sizes, componentCount: next - 1 };
}

/** The id of the largest component, or 0 if nothing is passable. */
export function primaryComponent(result: FloodResult): number {
	let best = 0;
	let bestSize = 0;
	for (let id = 1; id <= result.componentCount; id++) {
		const size = result.sizes[id] ?? 0;
		if (size > bestSize) {
			bestSize = size;
			best = id;
		}
	}
	return best;
}

export function componentAt(result: FloodResult, bounds: Rect, x: number, y: number): number {
	const lx = x - bounds.x;
	const ly = y - bounds.y;
	if (lx < 0 || ly < 0 || lx >= bounds.w || ly >= bounds.h) return 0;
	return result.labels[ly * bounds.w + lx] ?? 0;
}
