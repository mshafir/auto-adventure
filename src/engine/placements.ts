import { getInterior } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { generateFeature } from "../core/gen/features/registry.js";
import "../core/gen/features/builders.js";
import { isContainer } from "../core/rules/loot.js";
import type { Placement, ResolvedPlacement } from "../core/rules/placement.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { MACRO, type MacroSite, macroSite } from "../core/world/macro.js";
import type { WorldSeed } from "../core/world/recipe.js";
import type { SiteSpec } from "../core/world/spec.js";

/**
 * Turn authored placements into definite tiles.
 *
 * The `site` spelling — "in the chest in the smithy" — is the only one an author can
 * write from the story alone, and it is the only one that needs the world to exist
 * before it means anything. Resolving it here rather than at authoring time keeps
 * that ergonomics available to a hand-written scenario, at the cost of generating a
 * settlement and an interior per placement when the world opens. Both are memoised
 * and a scenario has a handful of placements, so this is tens of milliseconds once.
 *
 * Unresolvable placements are *returned*, not dropped silently. An item that is
 * quietly nowhere is the failure that matters: a `have` objective naming it can never
 * be satisfied and nothing on screen says why.
 */
export interface PlacementResolution {
	readonly resolved: readonly ResolvedPlacement[];
	/** Placements that name nothing that exists, with the reason. */
	readonly unresolved: readonly { readonly id: string; readonly reason: string }[];
}

export interface ResolveOptions {
	readonly world: WorldSeed;
	/** The authored description of a site, for the roster its settlement is built from. */
	readonly siteSpec: (siteId: number) => SiteSpec | undefined;
	/**
	 * The edge of the world, needed to find a site by id.
	 *
	 * A site's position is a function of its macro cell and nothing carries the cell,
	 * so finding one by id means sweeping. Bounded worlds can be swept; an unbounded
	 * one cannot, which is why the `site` spelling is a scenario feature — and a live
	 * world has no authored placements to resolve in the first place.
	 */
	readonly bounds?: WorldBounds;
}

export function resolvePlacements(
	placements: readonly Placement[] | undefined,
	options: ResolveOptions,
): PlacementResolution {
	const resolved: ResolvedPlacement[] = [];
	const unresolved: { id: string; reason: string }[] = [];
	if (!placements || placements.length === 0) return { resolved, unresolved };

	let sites: Map<number, MacroSite> | undefined;

	for (const placement of placements) {
		const at = placement.at;

		if (at.kind === "world") {
			resolved.push({ id: placement.id, placement, x: at.x, y: at.y });
			continue;
		}
		if (at.kind === "interior") {
			resolved.push({
				id: placement.id,
				placement,
				interiorId: at.interiorId,
				x: at.x,
				y: at.y,
			});
			continue;
		}

		if (!options.bounds) {
			unresolved.push({
				id: placement.id,
				reason: "a site placement needs a bounded world to find the site in",
			});
			continue;
		}
		sites ??= sweepSites(options.world, options.bounds);
		const site = sites.get(at.siteId);
		const spec = options.siteSpec(at.siteId);
		if (!site || !spec) {
			unresolved.push({ id: placement.id, reason: `site ${at.siteId} is not in this world` });
			continue;
		}
		// Any site with buildings will do, not only a settlement. A castle keep and a
		// warehouse on a dock are exactly the kind of place a scenario wants to hide
		// something in, and refusing them by kind rather than by what was actually built
		// would make the two most interesting new features unusable for placements.
		const built = generateFeature(options.world, site, spec.settlement);
		if (!built || built.buildings.length === 0) {
			unresolved.push({
				id: placement.id,
				reason: `site ${at.siteId} is a ${site.kind}, which has no buildings to put anything in`,
			});
			continue;
		}
		// First by index rather than nearest or largest: the index is the order the
		// generator assigned plots in, so it is stable across runs, which is the only
		// property that matters for a placement having to land in the same room twice.
		const building = at.structure
			? built.buildings.find((candidate) => candidate.kind === at.structure)
			: built.buildings[0];
		if (!building) {
			unresolved.push({
				id: placement.id,
				reason: `${spec.name} has no ${at.structure ?? "building"}`,
			});
			continue;
		}

		const spot = spotInside(options.world.seed, building.interiorId, building.kind, at.anchor);
		if (!spot) {
			unresolved.push({
				id: placement.id,
				reason: `nothing in the ${building.kind} at ${spec.name} can hold anything`,
			});
			continue;
		}

		resolved.push({
			id: placement.id,
			// A spot that is bare floor rather than a container has to be marked, or the
			// item is on a tile with no reason to search it.
			placement: spot.container ? placement : { ...placement, showDecor: true },
			interiorId: building.interiorId,
			x: spot.x,
			y: spot.y,
		});
	}

	return { resolved, unresolved };
}

/**
 * Where inside a building an item goes.
 *
 * A container first, because that is what the player already opens and because
 * `containerContents` has furnished every room with several. A named anchor if the
 * author asked for one. Bare floor last, and the caller marks that case visible —
 * an item on an unremarkable floor tile is an item nobody finds.
 *
 * Scanned in row-major order rather than picked at random: this must land on the
 * same tile every time the world is opened, or an item moves between sessions.
 */
function spotInside(
	seed: number,
	interiorId: number,
	kind: StructureKind,
	anchor: string | undefined,
): { readonly x: number; readonly y: number; readonly container: boolean } | undefined {
	const interior = getInterior(seed, interiorId, kind);

	if (anchor) {
		const named = interior.anchors.find((candidate) => candidate.kind === anchor);
		if (named) {
			const decor = interior.decor[named.y * interior.width + named.x] ?? 0;
			return { x: named.x, y: named.y, container: isContainer(decor) };
		}
	}

	for (let y = 0; y < interior.height; y++) {
		for (let x = 0; x < interior.width; x++) {
			if (isContainer(interior.decor[y * interior.width + x] ?? 0)) {
				return { x, y, container: true };
			}
		}
	}

	// No container at all — a ruin, a stripped room. Any floor tile that is not the
	// doorway will do, since the caller makes it visible.
	for (let y = 1; y < interior.height - 1; y++) {
		for (let x = 1; x < interior.width - 1; x++) {
			if (x === interior.entrance.x && y >= interior.entrance.y) continue;
			if ((interior.decor[y * interior.width + x] ?? 0) !== 0) continue;
			return { x, y, container: false };
		}
	}
	return undefined;
}

/**
 * Every site of this seed inside the boundary, by id.
 *
 * The same sweep `scenario/validate.ts` does, and for the same reason: `macroSite` is
 * the only authority on where a site is, and nothing carries the macro cell that
 * would let one be found directly.
 */
function sweepSites(world: WorldSeed, bounds: WorldBounds): Map<number, MacroSite> {
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
