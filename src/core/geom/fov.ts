/**
 * Recursive shadowcasting.
 *
 * The standard eight-octant algorithm: each octant is swept row by row,
 * narrowing the visible slope range as walls are met and recursing into the
 * gaps between them. Symmetric enough to look right, and O(visible cells)
 * rather than O(radius²·ray length) like naive raycasting.
 *
 * Used indoors and in caves, where not seeing round corners is the point. The
 * open world is drawn in full: hiding a landscape behind a torch radius makes
 * an infinite map feel like a corridor.
 */

export interface FovResult {
	/** 1 where lit, falling off with distance; 0 where hidden. */
	readonly light: Float32Array;
	readonly originX: number;
	readonly originY: number;
	readonly radius: number;
	readonly size: number;
}

/** Row/column multipliers for each of the eight octants. */
const OCTANTS: readonly (readonly [number, number, number, number])[] = [
	[1, 0, 0, 1],
	[0, 1, 1, 0],
	[0, -1, 1, 0],
	[-1, 0, 0, 1],
	[-1, 0, 0, -1],
	[0, -1, -1, 0],
	[0, 1, -1, 0],
	[1, 0, 0, -1],
];

export function computeFov(
	originX: number,
	originY: number,
	radius: number,
	blocksSight: (x: number, y: number) => boolean,
): FovResult {
	const size = radius * 2 + 1;
	const light = new Float32Array(size * size);

	const set = (x: number, y: number, value: number) => {
		const lx = x - originX + radius;
		const ly = y - originY + radius;
		if (lx < 0 || ly < 0 || lx >= size || ly >= size) return;
		const i = ly * size + lx;
		if (value > (light[i] as number)) light[i] = value;
	};

	set(originX, originY, 1);

	for (const [xx, xy, yx, yy] of OCTANTS) {
		castLight(1, 1, 0, xx, xy, yx, yy);
	}

	return { light, originX, originY, radius, size };

	function castLight(
		row: number,
		startSlope: number,
		endSlope: number,
		xx: number,
		xy: number,
		yx: number,
		yy: number,
	): void {
		if (startSlope < endSlope) return;
		let blocked = false;
		let nextStart = startSlope;

		for (let distance = row; distance <= radius && !blocked; distance++) {
			for (let deltaY = -distance; deltaY <= 0; deltaY++) {
				const deltaX = -distance;
				const currentX = originX + deltaX * xx + deltaY * xy;
				const currentY = originY + deltaX * yx + deltaY * yy;
				const leftSlope = (deltaY - 0.5) / (deltaX + 0.5);
				const rightSlope = (deltaY + 0.5) / (deltaX - 0.5);

				if (rightSlope > nextStart) continue;
				if (leftSlope < endSlope) break;

				const distanceSquared = deltaX * deltaX + deltaY * deltaY;
				if (distanceSquared <= radius * radius) {
					// A gentle falloff reads as lamplight rather than as a hard disc.
					const falloff = 1 - Math.sqrt(distanceSquared) / (radius + 1);
					set(currentX, currentY, Math.max(0.25, falloff));
				}

				const opaque = blocksSight(currentX, currentY);
				if (blocked) {
					if (opaque) {
						nextStart = rightSlope;
					} else {
						blocked = false;
						startSlope = nextStart;
					}
				} else if (opaque && distance < radius) {
					blocked = true;
					castLight(distance + 1, startSlope, leftSlope, xx, xy, yx, yy);
					nextStart = rightSlope;
				}
			}
		}
	}
}

/** Light level at a world position, or 0 if it is outside the computed field. */
export function lightAt(fov: FovResult, x: number, y: number): number {
	const lx = x - fov.originX + fov.radius;
	const ly = y - fov.originY + fov.radius;
	if (lx < 0 || ly < 0 || lx >= fov.size || ly >= fov.size) return 0;
	return fov.light[ly * fov.size + lx] ?? 0;
}
