import { hash3 } from "./hash.js";

/**
 * 2D simplex noise, sampled in *global* world coordinates.
 *
 * This is the reason chunk seams cannot exist at the terrain level: the field
 * is a pure function of position with no notion of a chunk, so a tile computed
 * while generating chunk A and the same tile computed while generating chunk B
 * are the same expression evaluated twice. There is no boundary in the function,
 * therefore no boundary in the output.
 *
 * Gradients come from hashing the lattice coordinate rather than from a shuffled
 * permutation table, so the field depends on the world seed without any shared
 * mutable setup — which is also what keeps this safe to run in a worker.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// 8 evenly spaced gradient directions. Eight is enough in 2D and keeps the
// lookup to a 3-bit mask.
const D = Math.SQRT1_2;
const GRAD_X = [1, -1, 0, 0, D, -D, D, -D];
const GRAD_Y = [0, 0, 1, -1, D, D, -D, -D];

function corner(seed: number, ix: number, iy: number, dx: number, dy: number): number {
	// The classic radius is 0.5; 0.6 is the widely used variant that removes the
	// faint grid artefacts visible when the field is used for terrain.
	let t = 0.5 - dx * dx - dy * dy;
	if (t < 0) return 0;
	const g = hash3(seed, ix, iy) & 7;
	t *= t;
	return t * t * ((GRAD_X[g] as number) * dx + (GRAD_Y[g] as number) * dy);
}

/** Simplex noise in roughly `[-1, 1]`. */
export function noise2(seed: number, x: number, y: number): number {
	const s = (x + y) * F2;
	const i = Math.floor(x + s);
	const j = Math.floor(y + s);

	const t = (i + j) * G2;
	const x0 = x - (i - t);
	const y0 = y - (j - t);

	const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];

	const x1 = x0 - i1 + G2;
	const y1 = y0 - j1 + G2;
	const x2 = x0 - 1 + 2 * G2;
	const y2 = y0 - 1 + 2 * G2;

	const n0 = corner(seed, i, j, x0, y0);
	const n1 = corner(seed, i + i1, j + j1, x1, y1);
	const n2 = corner(seed, i + 1, j + 1, x2, y2);

	return 70 * (n0 + n1 + n2);
}

export interface FbmOptions {
	readonly octaves?: number;
	readonly lacunarity?: number;
	readonly gain?: number;
	/** World units per noise unit. Larger means broader features. */
	readonly scale?: number;
}

/** Fractal Brownian motion, normalised to roughly `[-1, 1]`. */
export function fbm2(seed: number, x: number, y: number, options: FbmOptions = {}): number {
	const octaves = options.octaves ?? 4;
	const lacunarity = options.lacunarity ?? 2;
	const gain = options.gain ?? 0.5;
	const scale = options.scale ?? 1;

	let frequency = 1 / scale;
	let amplitude = 1;
	let total = 0;
	let norm = 0;

	for (let o = 0; o < octaves; o++) {
		// Each octave gets its own seed so octaves are not correlated copies.
		total += amplitude * noise2(seed + o * 0x9e37, x * frequency, y * frequency);
		norm += amplitude;
		frequency *= lacunarity;
		amplitude *= gain;
	}

	return norm > 0 ? total / norm : 0;
}

/** Ridged noise: sharp crests, useful for mountain spines. */
export function ridged2(seed: number, x: number, y: number, options: FbmOptions = {}): number {
	return 1 - Math.abs(fbm2(seed, x, y, options));
}

/**
 * Offset the sample point by another noise field before sampling.
 *
 * Without this, fbm coastlines and biome borders come out as recognisably
 * circular blobs. Warping the domain gives them the folded, fingered look of
 * real terrain at almost no extra cost.
 */
export function domainWarp2(
	seed: number,
	x: number,
	y: number,
	amplitude: number,
	options: FbmOptions = {},
): readonly [number, number] {
	const wx = fbm2(seed ^ 0x5f3a, x, y, options);
	const wy = fbm2(seed ^ 0x27d4, x, y, options);
	return [x + wx * amplitude, y + wy * amplitude];
}

/** Map roughly-`[-1, 1]` noise onto `[0, 1]`. */
export function unit(value: number): number {
	const v = (value + 1) * 0.5;
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
