import type { Vec2 } from "../geom/vec.js";
import { hash32 } from "../rand/hash.js";
import { valueFor } from "../rand/rng.js";
import type { WorldBounds } from "./bounds.js";
import { CHUNK, HALO } from "./coords.js";
import { civilizationAt, elevationAt, slopeAt } from "./fields.js";
import { placeKey, type SettledKind, type WorldRules, type WorldSeed } from "./recipe.js";

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
	| "landmark"
	| "cave"
	| "castle"
	| "docks";

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
	/** True when a scenario put this here rather than the roll finding it. */
	readonly authored?: boolean;
}

/** Region cells are much larger than macro cells: a region spans many chunks. */
export const REGION = MACRO * 6;

export function regionIdAt(seed: number, x: number, y: number): number {
	return hash32(seed, 0x5e91, Math.floor(x / REGION), Math.floor(y / REGION));
}

function siteRadius(rules: WorldRules, kind: SiteKind, importance: number): number {
	if (kind === "none") return 0;
	const rule = rules.sites.radius[kind];
	return rule.base + (rule.perImportance ?? 0) * importance;
}

/**
 * How far an authored place will reach, before the world has been resolved with it in.
 *
 * The same arithmetic {@link macroSite} applies, exported because two callers need the answer
 * *before* the place exists: founding, to refuse one that would run into its neighbour, and
 * validation, to say so about a file that already has. Written twice it would be a rule the
 * generator and its own validator could disagree about.
 */
export function placeRadius(
	place: { readonly kind: SettledKind; readonly importance?: number; readonly radius?: number },
	rules: WorldRules,
): number {
	return place.radius ?? siteRadius(rules, place.kind, place.importance ?? 3);
}

/**
 * The site occupying a macro cell, if any.
 *
 * Pure in `(world, mx, my)` and nothing else. Two chunks that both see this site
 * — because a large town straddles them — receive the identical object, which
 * is what lets the settlement be generated once and clipped into both.
 *
 * The id is hashed from the seed and the cell alone, deliberately excluding both
 * the recipe and the kind. A `SiteSpec` names a site by id, so an authored place
 * has to key the same way a rolled one does — otherwise moving a town in the recipe
 * would silently orphan the roster written for it.
 */
export function macroSite(world: WorldSeed, mx: number, my: number): MacroSite {
	const { seed, rules } = world;
	const id = hash32(seed, 0x51e0, mx, my);
	const regionOf = (at: Vec2) => regionIdAt(seed, at.x, at.y);

	// An authored place overrides the cell outright. It keeps the cell's id and its
	// region, so everything downstream — roads, specs, the halo — treats it as the
	// site that cell has, not as a second thing sharing the cell with one.
	const authored = rules.places.get(placeKey(mx, my));
	if (authored) {
		const importance = clampImportance(authored.importance ?? 3, rules);
		const site: Vec2 = { x: Math.round(authored.at.x), y: Math.round(authored.at.y) };
		return {
			id,
			mx,
			my,
			site,
			kind: authored.kind,
			importance,
			radius: authored.radius ?? siteRadius(rules, authored.kind, importance),
			regionId: regionOf(site),
			authored: true,
		};
	}

	// Jitter well inside the cell so neighbouring sites cannot end up adjacent.
	const jx = valueFor(seed, "site:x", mx, my);
	const jy = valueFor(seed, "site:y", mx, my);
	const inset = MACRO * 0.22;
	const site: Vec2 = {
		x: Math.round(mx * MACRO + inset + jx * (MACRO - inset * 2)),
		y: Math.round(my * MACRO + inset + jy * (MACRO - inset * 2)),
	};

	const kind = siteKindAt(world, mx, my, site);
	const importance =
		kind === "none"
			? 0
			: 1 + Math.floor(valueFor(seed, "site:importance", mx, my) * rules.sites.maxImportance);

	return {
		id,
		mx,
		my,
		site,
		kind,
		importance,
		radius: siteRadius(rules, kind, importance),
		regionId: regionOf(site),
	};
}

function clampImportance(importance: number, rules: WorldRules): number {
	return Math.max(1, Math.min(rules.sites.maxImportance, Math.round(importance)));
}

/**
 * Which kind of site a cell rolls, from the recipe's ladder.
 *
 * The ladder is consumed from the top of the roll downward, so a kind's share of
 * the map is its own weight and nothing else's. That is the same arithmetic the
 * hand-written threshold chain did — `roll > 0.985` was a 1.5% share — which is why
 * the default weights reproduce the old world exactly.
 */
function siteKindAt(world: WorldSeed, mx: number, my: number, site: Vec2): SiteKind {
	const { seed, rules } = world;
	if (elevationAt(world, site.x, site.y) < rules.climate.seaLevel) return "none";

	const roll = valueFor(seed, "site:kind", mx, my);
	const civilization = civilizationAt(world, site.x, site.y);
	const steep = slopeAt(world, site.x, site.y) > rules.sites.maxSlope;

	// Uninhabitable ground still gets ruins and landmarks — the world should not
	// go blank just because nobody could live there.
	const ladder =
		civilization < rules.sites.civilizationFloor || steep ? rules.sites.wild : rules.sites.settled;

	for (const [kind, threshold] of ladder) {
		if (roll > threshold) return kind;
	}
	return "none";
}

/** Every site within the halo of a chunk, in a deterministic order. */
export function sitesAround(world: WorldSeed, cx: number, cy: number, halo = HALO): MacroSite[] {
	const sites: MacroSite[] = [];
	for (let my = cy - halo; my <= cy + halo; my++) {
		for (let mx = cx - halo; mx <= cx + halo; mx++) {
			const site = macroSite(world, mx, my);
			if (site.kind !== "none") sites.push(site);
		}
	}
	// Sorting by cell coordinate rather than by id keeps the order stable and
	// independent of which chunk asked, which is what the MST relies on.
	sites.sort((a, b) => a.my - b.my || a.mx - b.mx);
	return sites;
}

/**
 * Every site of a bounded world, by id.
 *
 * `macroSite` is the only authority on where a site is and nothing carries the macro
 * cell, so finding one *by id* means sweeping every cell of the world. That is only
 * affordable — and only meaningful — for a bounded one, which is why every caller is a
 * scenario pass: resolving a gate named by its castle, an item hidden in a named town, a
 * signpost pointing at a place.
 *
 * One cell of margin on each side, because a site's footprint reaches past its own cell
 * and a town whose centre sits just outside the boundary still has streets inside it.
 */
export function sitesInside(world: WorldSeed, bounds: WorldBounds): Map<number, MacroSite> {
	const found = new Map<number, MacroSite>();
	const minMx = Math.floor(bounds.minX / MACRO) - 1;
	const maxMx = Math.floor(bounds.maxX / MACRO) + 1;
	const minMy = Math.floor(bounds.minY / MACRO) - 1;
	const maxMy = Math.floor(bounds.maxY / MACRO) + 1;
	for (let my = minMy; my <= maxMy; my++) {
		for (let mx = minMx; mx <= maxMx; mx++) {
			const site = macroSite(world, mx, my);
			if (site.kind !== "none") found.set(site.id, site);
		}
	}
	return found;
}

/**
 * The kinds that have buildings, and so the kinds a person can be put in.
 *
 * Ordered small to large, which is the order an author reads them in when choosing.
 */
export const SETTLEMENT_KINDS = ["hamlet", "village", "town", "fort"] as const;

/** Whether a site is a settlement (has buildings) rather than a point feature. */
export function isSettlement(kind: SiteKind): boolean {
	return (SETTLEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The largest radius any feature can project beyond its own macro cell.
 * Asserted against the halo at startup: if a feature could reach further than
 * the halo consults, chunks would disagree about whether it exists.
 *
 * Authored places are measured too. A recipe that puts a radius-90 city somewhere
 * would otherwise reach two cells further than the halo looks, and the chunks two
 * cells away would generate open field where the city's outskirts are.
 */
export function maxFeatureRadius(rules: WorldRules): number {
	let max = 0;
	for (const kind of Object.keys(rules.sites.radius) as SettledKind[]) {
		max = Math.max(max, siteRadius(rules, kind, rules.sites.maxImportance));
	}
	for (const place of rules.places.values()) {
		max = Math.max(max, place.radius ?? 0);
	}
	return max;
}
