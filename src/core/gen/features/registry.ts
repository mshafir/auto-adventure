import { type Rect, rectIntersection } from "../../geom/vec.js";
import type { MacroSite, SiteKind } from "../../world/macro.js";
import { type WorldSeed, worldKey } from "../../world/recipe.js";
import type { FeaturePatch } from "./patch.js";
import type { SettlementSpec } from "./settlement.js";

/**
 * One kind of thing the generator knows how to build on a site.
 *
 * The generator used to have exactly one: `settlementsOverlapping` was called
 * directly from the pipeline, and adding a castle meant adding a second special case
 * to the pipeline beside it, then a third for docks. What every one of them has in
 * common is the shape below — *does this site belong to me*, *how far do I reach*,
 * *build it* — so that shape is the interface, and the pipeline iterates registrants
 * instead of naming them.
 *
 * A new region is then one new file and one `register()` call, which is the seam a
 * plugin system would eventually slot into.
 *
 * All three methods must be pure in their arguments. `bounds` in particular is
 * consulted before `build` in order to reject sites cheaply, so the two must agree:
 * a patch that spilled outside its declared bounds would be clipped away in the
 * chunks that rejected it and drawn in the ones that did not.
 */
export interface FeatureKind {
	readonly id: string;
	/** Site kinds this builder owns. Two builders claiming a kind is a programming error. */
	readonly accepts: readonly SiteKind[];
	/** Where the patch will be, computable without building it. */
	bounds(site: MacroSite, world: WorldSeed): Rect;
	build(world: WorldSeed, site: MacroSite, spec: SettlementSpec): FeaturePatch;
}

const kinds = new Map<SiteKind, FeatureKind>();
const patchCache = new Map<string, FeaturePatch>();

export function registerFeature(kind: FeatureKind): void {
	for (const site of kind.accepts) {
		const already = kinds.get(site);
		if (already && already.id !== kind.id) {
			throw new Error(`${kind.id} and ${already.id} both claim the site kind "${site}"`);
		}
		kinds.set(site, kind);
	}
}

/** The builder that owns a site kind, if any does. */
export function featureKindFor(kind: SiteKind): FeatureKind | undefined {
	return kinds.get(kind);
}

/** Every registered builder, for tests and tooling. */
export function registeredFeatures(): readonly FeatureKind[] {
	return [...new Set(kinds.values())];
}

/**
 * A site's patch bounds, computable without generating it.
 *
 * Having this separate is what lets a chunk reject the features it does not overlap
 * before paying to build them — otherwise every chunk generates every town in its
 * halo and throws almost all of them away.
 */
export function featureBounds(site: MacroSite, world: WorldSeed): Rect {
	return kinds.get(site.kind)?.bounds(site, world) ?? emptyAt(site);
}

/**
 * The feature at a site, generated once and cached.
 *
 * Cached by world and site id and never regenerated per chunk. This is the single
 * most important structural decision in the generator: a town is an *object* that
 * chunks are windows onto, not a thing that lives inside a chunk. A town straddling
 * four chunks is generated once and clipped four ways, so there is nothing for the
 * four chunks to disagree about.
 *
 * The key includes the recipe, not just the seed. Two scenarios can share a seed and
 * differ in their recipe, and serving one's cached town to the other would be a
 * silent, unreproducible corruption of somebody else's world.
 */
export function generateFeature(
	world: WorldSeed,
	site: MacroSite,
	spec: SettlementSpec,
): FeaturePatch | undefined {
	const kind = kinds.get(site.kind);
	if (!kind) return undefined;

	const key = `${worldKey(world)}:${kind.id}:${site.id}`;
	const cached = patchCache.get(key);
	if (cached) return cached;

	const built = kind.build(world, site, spec);
	patchCache.set(key, built);
	return built;
}

export function clearFeatureCache(): void {
	patchCache.clear();
}

/**
 * Forget one feature so it is rebuilt from a new spec.
 *
 * The only reason this exists is the director: a town built from the fallback roster
 * has to be regenerated once its authored roster arrives. Callers are responsible for
 * invalidating the chunks that had already stamped the old patch, which is why
 * {@link featureBounds} is exported.
 *
 * Clears the entry under every registered builder rather than looking the site's kind
 * up, because the caller has an id and not always a site — and a stale entry left
 * behind is a town that never picks up its authored roster.
 */
export function invalidateFeature(world: WorldSeed, siteId: number): void {
	for (const kind of new Set(kinds.values())) {
		patchCache.delete(`${worldKey(world)}:${kind.id}:${siteId}`);
	}
}

/** Every feature patch whose bounds overlap a rectangle. */
export function featuresOverlapping(
	world: WorldSeed,
	sites: readonly MacroSite[],
	specFor: (site: MacroSite) => SettlementSpec,
	area: Rect,
): FeaturePatch[] {
	const patches: FeaturePatch[] = [];
	for (const site of sites) {
		// Reject on the site's declared bounds first; generating a settlement in order
		// to discover it is somewhere else costs tens of milliseconds.
		if (!kinds.has(site.kind)) continue;
		if (!rectIntersection(featureBounds(site, world), area)) continue;
		const patch = generateFeature(world, site, specFor(site));
		if (patch) patches.push(patch);
	}
	// Deterministic priority: larger id wins where two features overlap.
	patches.sort((a, b) => a.id - b.id);
	return patches;
}

function emptyAt(site: MacroSite): Rect {
	return { x: site.site.x, y: site.site.y, w: 0, h: 0 };
}
