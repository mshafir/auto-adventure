import type { Vec2 } from "../geom/vec.js";
import { hash32 } from "../rand/hash.js";
import { valueFor } from "../rand/rng.js";
import { CHUNK, HALO } from "./coords.js";
import { civilizationAt, elevationAt, SEA_LEVEL, slopeAt } from "./fields.js";

/** One macro cell per chunk. Sites are placed at macro-cell resolution. */
export const MACRO = CHUNK;

export type SiteKind =
	| "none"
	| "hamlet"
	| "village"
	| "town"
	| "fort"
	| "camp"
	| "ruins"
	| "landmark";

export interface MacroSite {
	readonly id: number;
	readonly mx: number;
	readonly my: number;
	/** World position, jittered within the macro cell. */
	readonly site: Vec2;
	readonly kind: SiteKind;
	/** 1..5. Drives footprint radius and how many buildings the spec may place. */
	readonly importance: number;
	/** Radius in tiles of the area this site occupies. */
	readonly radius: number;
	/** Region this site belongs to; regions own naming and biome flavour. */
	readonly regionId: number;
}

/** Region cells are much larger than macro cells: a region spans many chunks. */
export const REGION = MACRO * 6;

export function regionIdAt(seed: number, x: number, y: number): number {
	return hash32(seed, 0x5e91, Math.floor(x / REGION), Math.floor(y / REGION));
}

function siteRadius(kind: SiteKind, importance: number): number {
	switch (kind) {
		case "town":
			return 20 + importance * 3;
		case "village":
			return 14 + importance * 2;
		case "fort":
			return 13 + importance;
		case "hamlet":
			return 9 + importance;
		case "ruins":
			return 10 + importance;
		case "camp":
			return 6;
		case "landmark":
			return 4;
		case "none":
			return 0;
	}
}

/**
 * The site occupying a macro cell, if any.
 *
 * Pure in `(seed, mx, my)` and nothing else. Two chunks that both see this site
 * — because a large town straddles them — receive the identical object, which
 * is what lets the settlement be generated once and clipped into both.
 */
export function macroSite(seed: number, mx: number, my: number): MacroSite {
	const id = hash32(seed, 0x51e0, mx, my);

	// Jitter well inside the cell so neighbouring sites cannot end up adjacent.
	const jx = valueFor(seed, "site:x", mx, my);
	const jy = valueFor(seed, "site:y", mx, my);
	const inset = MACRO * 0.22;
	const site: Vec2 = {
		x: Math.round(mx * MACRO + inset + jx * (MACRO - inset * 2)),
		y: Math.round(my * MACRO + inset + jy * (MACRO - inset * 2)),
	};

	const kind = siteKindAt(seed, mx, my, site);
	const importance =
		kind === "none" ? 0 : 1 + Math.floor(valueFor(seed, "site:importance", mx, my) * 5);

	return {
		id,
		mx,
		my,
		site,
		kind,
		importance,
		radius: siteRadius(kind, importance),
		regionId: regionIdAt(seed, site.x, site.y),
	};
}

function siteKindAt(seed: number, mx: number, my: number, site: Vec2): SiteKind {
	const elevation = elevationAt(seed, site.x, site.y);
	if (elevation < SEA_LEVEL) return "none";

	const roll = valueFor(seed, "site:kind", mx, my);
	const civilization = civilizationAt(seed, site.x, site.y);
	const steep = slopeAt(seed, site.x, site.y) > 0.035;

	// Uninhabitable ground still gets ruins and landmarks — the world should not
	// go blank just because nobody could live there.
	if (civilization < 0.16 || steep) {
		if (roll > 0.94) return "ruins";
		if (roll > 0.88) return "landmark";
		return "none";
	}

	// Roughly one in five habitable cells carries something. Denser than this
	// and settlement footprints start overlapping, which the clip-into-chunks
	// model handles but which reads as sprawl rather than as distinct places.
	if (roll > 0.985) return "town";
	if (roll > 0.96) return "village";
	if (roll > 0.945) return "fort";
	if (roll > 0.9) return "hamlet";
	if (roll > 0.87) return "camp";
	if (roll > 0.845) return "ruins";
	if (roll > 0.82) return "landmark";
	return "none";
}

/** Every site within the halo of a chunk, in a deterministic order. */
export function sitesAround(seed: number, cx: number, cy: number, halo = HALO): MacroSite[] {
	const sites: MacroSite[] = [];
	for (let my = cy - halo; my <= cy + halo; my++) {
		for (let mx = cx - halo; mx <= cx + halo; mx++) {
			const site = macroSite(seed, mx, my);
			if (site.kind !== "none") sites.push(site);
		}
	}
	// Sorting by cell coordinate rather than by id keeps the order stable and
	// independent of which chunk asked, which is what the MST relies on.
	sites.sort((a, b) => a.my - b.my || a.mx - b.mx);
	return sites;
}

/** Whether a site is a settlement (has buildings) rather than a point feature. */
export function isSettlement(kind: SiteKind): boolean {
	return kind === "hamlet" || kind === "village" || kind === "town" || kind === "fort";
}

/**
 * The largest radius any feature can project beyond its own macro cell.
 * Asserted against the halo at startup: if a feature could reach further than
 * the halo consults, chunks would disagree about whether it exists.
 */
export function maxFeatureRadius(): number {
	let max = 0;
	for (const kind of ["town", "village", "fort", "hamlet", "ruins", "camp", "landmark"] as const) {
		max = Math.max(max, siteRadius(kind, 5));
	}
	return max;
}
