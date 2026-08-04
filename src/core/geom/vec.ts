export interface Vec2 {
	readonly x: number;
	readonly y: number;
}

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export function vec(x: number, y: number): Vec2 {
	return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
	return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
	return { x: a.x - b.x, y: a.y - b.y };
}

export function dist(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist2(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

export function chebyshev(a: Vec2, b: Vec2): number {
	return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function manhattan(a: Vec2, b: Vec2): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function rect(x: number, y: number, w: number, h: number): Rect {
	return { x, y, w, h };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
	return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function rectCenter(r: Rect): Vec2 {
	return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
}

export function rectInset(r: Rect, by: number): Rect {
	return { x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 };
}

export function rectIntersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectIntersection(a: Rect, b: Rect): Rect | undefined {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const w = Math.min(a.x + a.w, b.x + b.w) - x;
	const h = Math.min(a.y + a.h, b.y + b.h) - y;
	return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

export const ORTHOGONAL: readonly Vec2[] = [
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 },
];

export const DIAGONAL: readonly Vec2[] = [
	{ x: 1, y: -1 },
	{ x: 1, y: 1 },
	{ x: -1, y: 1 },
	{ x: -1, y: -1 },
];

export const ALL_EIGHT: readonly Vec2[] = [...ORTHOGONAL, ...DIAGONAL];
