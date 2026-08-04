import type { Vec2 } from "./vec.js";

/** Integer line rasterisation. Deterministic and symmetric in its stepping. */
export function bresenham(x0: number, y0: number, x1: number, y1: number): Vec2[] {
	const points: Vec2[] = [];
	let x = Math.round(x0);
	let y = Math.round(y0);
	const tx = Math.round(x1);
	const ty = Math.round(y1);

	const dx = Math.abs(tx - x);
	const dy = -Math.abs(ty - y);
	const sx = x < tx ? 1 : -1;
	const sy = y < ty ? 1 : -1;
	let err = dx + dy;

	// Bounded so a malformed input cannot spin forever inside chunk generation.
	const limit = dx - dy + 2;
	for (let i = 0; i <= limit; i++) {
		points.push({ x, y });
		if (x === tx && y === ty) break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			x += sx;
		}
		if (e2 <= dx) {
			err += dx;
			y += sy;
		}
	}
	return points;
}

export type Polyline = readonly Vec2[];

/** Rasterise a polyline, dropping the duplicated joints between segments. */
export function rasterizePolyline(points: Polyline): Vec2[] {
	if (points.length === 0) return [];
	const out: Vec2[] = [];
	let last: Vec2 | undefined;
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i] as Vec2;
		const b = points[i + 1] as Vec2;
		for (const p of bresenham(a.x, a.y, b.x, b.y)) {
			if (last && last.x === p.x && last.y === p.y) continue;
			out.push(p);
			last = p;
		}
	}
	if (out.length === 0 && points[0]) out.push(points[0]);
	return out;
}

/** Squared distance from a point to a segment; avoids a square root per test. */
export function distToSegment2(px: number, py: number, a: Vec2, b: Vec2): number {
	const vx = b.x - a.x;
	const vy = b.y - a.y;
	const len2 = vx * vx + vy * vy;
	if (len2 === 0) {
		const dx = px - a.x;
		const dy = py - a.y;
		return dx * dx + dy * dy;
	}
	let t = ((px - a.x) * vx + (py - a.y) * vy) / len2;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const dx = px - (a.x + t * vx);
	const dy = py - (a.y + t * vy);
	return dx * dx + dy * dy;
}

export function distToPolyline2(px: number, py: number, points: Polyline): number {
	if (points.length === 0) return Number.POSITIVE_INFINITY;
	if (points.length === 1) {
		const p = points[0] as Vec2;
		return (px - p.x) ** 2 + (py - p.y) ** 2;
	}
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i + 1 < points.length; i++) {
		const d = distToSegment2(px, py, points[i] as Vec2, points[i + 1] as Vec2);
		if (d < best) best = d;
	}
	return best;
}

/**
 * Where two segments cross, if they do. Used to place bridges and fords at the
 * point a road meets a river — computed in world space so both chunks that see
 * the crossing compute the identical tile.
 */
export function segmentIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | undefined {
	const d1x = a2.x - a1.x;
	const d1y = a2.y - a1.y;
	const d2x = b2.x - b1.x;
	const d2y = b2.y - b1.y;
	const denom = d1x * d2y - d1y * d2x;
	if (denom === 0) return undefined;

	const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
	const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
	if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;

	return { x: Math.round(a1.x + t * d1x), y: Math.round(a1.y + t * d1y) };
}

export function polylineIntersections(a: Polyline, b: Polyline): Vec2[] {
	const out: Vec2[] = [];
	for (let i = 0; i + 1 < a.length; i++) {
		for (let j = 0; j + 1 < b.length; j++) {
			const hit = segmentIntersection(
				a[i] as Vec2,
				a[i + 1] as Vec2,
				b[j] as Vec2,
				b[j + 1] as Vec2,
			);
			if (hit) out.push(hit);
		}
	}
	return out;
}
