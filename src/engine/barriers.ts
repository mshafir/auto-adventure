import { castleGateTiles } from "../core/gen/features/castle.js";
import type { AuthoredBarrier, Barrier } from "../core/rules/lock.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { type MacroSite, sitesInside } from "../core/world/macro.js";
import type { WorldSeed } from "../core/world/recipe.js";

/**
 * Turn authored gates into definite tiles.
 *
 * The sibling of `placements.ts`, and for the same reason: a scenario should be able
 * to name a thing the generator makes rather than copy the coordinates out of it. A
 * castle's gatehouse is the only choke point in the game that is *guaranteed* to be
 * one — a closed curtain wall with a single gap — and the shipped scenario had its
 * three tiles pasted in by hand, kept honest only by a test that compared them back.
 *
 * Unresolvable spans are returned rather than dropped, exactly as with placements. A
 * gate that is quietly nowhere is worse than one that is reported: the player walks
 * into the courtyard the story was gating and nothing has gone wrong from the game's
 * own point of view.
 */
export interface BarrierResolution {
	readonly resolved: readonly Barrier[];
	readonly unresolved: readonly { readonly id: string; readonly reason: string }[];
}

export interface ResolveBarrierOptions {
	readonly world: WorldSeed;
	/**
	 * The edge of the world, needed to find a site by id.
	 *
	 * A site's position is a function of its macro cell and nothing carries the cell,
	 * so finding one by id means sweeping — which only a bounded world can afford, and
	 * only a scenario has authored gates in the first place.
	 */
	readonly bounds?: WorldBounds;
}

export function resolveBarriers(
	barriers: readonly AuthoredBarrier[] | undefined,
	options: ResolveBarrierOptions,
): BarrierResolution {
	const resolved: Barrier[] = [];
	const unresolved: { id: string; reason: string }[] = [];
	if (!barriers || barriers.length === 0) return { resolved, unresolved };

	let sites: Map<number, MacroSite> | undefined;

	for (const barrier of barriers) {
		if (Array.isArray(barrier.tiles)) {
			resolved.push({ ...barrier, tiles: barrier.tiles });
			continue;
		}
		const span = barrier.tiles as { siteId: number; at: "gate" };

		if (!options.bounds) {
			unresolved.push({
				id: barrier.id,
				reason: "a gate named by site needs a bounded world to find the site in",
			});
			continue;
		}
		sites ??= sitesInside(options.world, options.bounds);
		const site = sites.get(span.siteId);
		if (!site) {
			unresolved.push({ id: barrier.id, reason: `site ${span.siteId} is not in this world` });
			continue;
		}

		// Only a castle has one. A settlement's streets have as many ways in as they
		// have edges, so "the gate" of a village is not a thing that exists, and saying
		// so is better than barring one tile of an open road.
		const tiles = site.kind === "castle" ? castleGateTiles(options.world, site) : [];
		if (tiles.length === 0) {
			unresolved.push({
				id: barrier.id,
				reason:
					site.kind === "castle"
						? `the castle at ${site.site.x},${site.site.y} built no gate; it found no ground to stand on`
						: `site ${span.siteId} is a ${site.kind}, which has no single way in to bar`,
			});
			continue;
		}
		resolved.push({ ...barrier, tiles: tiles.map((tile) => ({ x: tile.x, y: tile.y })) });
	}

	return { resolved, unresolved };
}
