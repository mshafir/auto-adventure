import { hash4, hash32, hashString, mix32 } from "./hash.js";

export interface Rng {
	/** Raw uint32. */
	next(): number;
	/** Uniform in `[0, 1)`. */
	float(): number;
	/** Uniform in `[0, max)`. Returns 0 when `max <= 0`. */
	int(max: number): number;
	/** Uniform integer in `[min, max)`. */
	range(min: number, max: number): number;
	/** Uniform float in `[min, max)`. */
	between(min: number, max: number): number;
	chance(probability: number): boolean;
	pick<T>(items: readonly T[]): T | undefined;
	/** Index into a parallel array of non-negative weights. */
	weighted(weights: readonly number[]): number;
	/** Fisher-Yates on a copy; the input is never mutated. */
	shuffled<T>(items: readonly T[]): T[];
}

/** SplitMix32, used only to expand a single seed into generator state. */
function splitmix32(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x9e3779b9) | 0;
		let z = state;
		z ^= z >>> 16;
		z = Math.imul(z, 0x21f0aaad);
		z ^= z >>> 15;
		z = Math.imul(z, 0x735a2d97);
		z ^= z >>> 15;
		return z >>> 0;
	};
}

/**
 * xoshiro128** — small state, fast, and passes the statistical tests that
 * matter here. Chosen over `Math.random` because generation must be
 * reproducible, and over a bare LCG because low bits of an LCG correlate,
 * which shows up as visible diagonal banding in scatter.
 */
export function makeRng(seed: number): Rng {
	const seeder = splitmix32(seed >>> 0);
	let s0 = seeder();
	let s1 = seeder();
	let s2 = seeder();
	let s3 = seeder();
	// An all-zero state is a fixed point; nudge it if the seeding lands there.
	if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

	const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

	const next = (): number => {
		const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0) as number;
		const t = (s1 << 9) >>> 0;
		s2 = (s2 ^ s0) >>> 0;
		s3 = (s3 ^ s1) >>> 0;
		s1 = (s1 ^ s2) >>> 0;
		s0 = (s0 ^ s3) >>> 0;
		s2 = (s2 ^ t) >>> 0;
		s3 = rotl(s3, 11);
		return result;
	};

	const float = () => next() / 4294967296;

	const rng: Rng = {
		next,
		float,
		int: (max) => (max <= 0 ? 0 : Math.floor(float() * max)),
		range: (min, max) => min + rng.int(max - min),
		between: (min, max) => min + float() * (max - min),
		chance: (probability) => float() < probability,
		pick: (items) => items[rng.int(items.length)],
		weighted: (weights) => {
			let total = 0;
			for (const w of weights) total += w > 0 ? w : 0;
			if (total <= 0) return 0;
			let roll = float() * total;
			for (let i = 0; i < weights.length; i++) {
				const w = weights[i] ?? 0;
				if (w <= 0) continue;
				roll -= w;
				if (roll < 0) return i;
			}
			return weights.length - 1;
		},
		shuffled: (items) => {
			const out = [...items];
			for (let i = out.length - 1; i > 0; i--) {
				const j = rng.int(i + 1);
				const a = out[i] as (typeof out)[number];
				const b = out[j] as (typeof out)[number];
				out[i] = b;
				out[j] = a;
			}
			return out;
		},
	};

	return rng;
}

const streamCache = new Map<string, number>();

/**
 * Resolve a stream name to its numeric id.
 *
 * Hot loops should resolve this once, outside the loop, and then use
 * {@link valueAt} — building a stream name per tile allocates a string and
 * costs a map lookup for every sample.
 */
export function streamId(stream: string): number {
	let id = streamCache.get(stream);
	if (id === undefined) {
		id = hashString(stream);
		streamCache.set(stream, id);
	}
	return id;
}

/**
 * A generator for one named purpose at one location.
 *
 * Named streams are load-bearing, not decoration. Because `rngFor(s,'scatter',
 * cx, cy)` is independent of `rngFor(s,'plots',cx,cy)`, a stage added later
 * cannot shift the output of the stages before it — so adding stage 11 does not
 * invalidate the goldens for stages 1 through 10. Retrofitting this once the
 * goldens exist is miserable, which is why it is here from the first commit.
 */
export function rngFor(seed: number, stream: string, ...coords: readonly number[]): Rng {
	return makeRng(hash32(seed, streamId(stream), ...coords));
}

/** One-shot value in `[0, 1)` without allocating a generator. */
export function valueFor(seed: number, stream: string, ...coords: readonly number[]): number {
	return mix32(hash32(seed, streamId(stream), ...coords)) / 4294967296;
}

/** {@link valueFor} for a 2D position with a pre-resolved stream id. */
export function valueAt(seed: number, stream: number, x: number, y: number): number {
	return mix32(hash4(seed, stream, x, y)) / 4294967296;
}
