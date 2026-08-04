/**
 * Integer hashing for deterministic generation.
 *
 * Everything here is 32-bit and built from `Math.imul`, deliberately avoiding
 * `BigInt` and floating point. The world must hash identically on every machine
 * and in every Node version, and 32-bit integer arithmetic is the only thing
 * JavaScript specifies exactly.
 */

/** Final avalanche from murmur3. Diffuses every input bit across all 32. */
export function mix32(h: number): number {
	let x = h | 0;
	x ^= x >>> 16;
	x = Math.imul(x, 0x85ebca6b);
	x ^= x >>> 13;
	x = Math.imul(x, 0xc2b2ae35);
	x ^= x >>> 16;
	return x >>> 0;
}

function step(h: number, part: number): number {
	const x = Math.imul(h ^ (part | 0), 0x01000193);
	return (x << 13) | (x >>> 19);
}

/**
 * Fixed-arity hashes.
 *
 * These exist because the variadic form allocates an array on every call, and
 * the noise and scatter inner loops call it hundreds of thousands of times per
 * chunk — enough that the allocation, not the arithmetic, dominated generation
 * time. They are exactly equivalent to `hash32` with the same arguments.
 */
export function hash2(a: number, b: number): number {
	return mix32(step(step(0x811c9dc5 | 0, a), b));
}

export function hash3(a: number, b: number, c: number): number {
	return mix32(step(step(step(0x811c9dc5 | 0, a), b), c));
}

export function hash4(a: number, b: number, c: number, d: number): number {
	return mix32(step(step(step(step(0x811c9dc5 | 0, a), b), c), d));
}

/**
 * Hash an arbitrary number of integer parts into a uint32.
 *
 * Order matters, so `hash32(a, b) !== hash32(b, a)` — callers that need an
 * unordered pair must canonicalise first (see `canonPair`).
 */
export function hash32(...parts: readonly number[]): number {
	let h = 0x811c9dc5 | 0;
	for (const part of parts) h = step(h, part);
	return mix32(h);
}

export function hashString(text: string): number {
	let h = 0x811c9dc5 | 0;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	}
	return mix32(h);
}

/** A uint32 hash reinterpreted as a float in `[0, 1)`. */
export function hashFloat(...parts: readonly number[]): number {
	return hash32(...parts) / 4294967296;
}

/**
 * Order the two coordinate pairs so that an unordered pair of sites hashes the
 * same from either side.
 *
 * This is the one place edge-hashing belongs: deriving a shared object (a road,
 * a river crossing) from a pair of macro sites, where both chunks must agree on
 * the result regardless of which one asks first. It is *not* a substitute for
 * generating features in their own coordinate frame — agreeing on a shared
 * value does not make the two sides' interiors connect to it.
 */
export function canonPair(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): readonly [number, number, number, number] {
	if (ax < bx || (ax === bx && ay <= by)) return [ax, ay, bx, by];
	return [bx, by, ax, ay];
}

export function hashPair(ax: number, ay: number, bx: number, by: number): number {
	const [x1, y1, x2, y2] = canonPair(ax, ay, bx, by);
	return hash32(x1, y1, x2, y2);
}
