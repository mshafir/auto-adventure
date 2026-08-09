import { type Rng, rngFor } from "../../rand/rng.js";
import type { MacroSite } from "../../world/macro.js";
import type { RosterRule, WorldSeed } from "../../world/recipe.js";
import type { StructureKind } from "./patch.js";
import type { SettlementSpec, StructureSpec } from "./settlement.js";
import { structureDef } from "./structures.js";

/**
 * The settlement a place has when no LLM has described it.
 *
 * Every field the director can supply has a deterministic default here, which
 * is what lets the whole world be generated, played and tested offline. It is
 * also the value committed permanently when a director call fails, so a network
 * problem produces a plain village rather than a hole in the map.
 *
 * *What* a settlement is made of is no longer here: it is the recipe's
 * {@link RosterRule}, so a scenario can say that its villages are three longhouses
 * and a boat-shed. What stays is everything that is a property of the *structure*
 * rather than of the place — how big a plot it wants and how badly it wants one —
 * which no world has ever needed to disagree about.
 */
function structureCount(rule: RosterRule, importance: number): number {
	return rule.count.base + Math.floor((rule.count.perImportance ?? 0) * importance);
}

/**
 * Whether this place has a wall round it.
 *
 * `true` is unconditional and a number is a threshold on importance, which is the
 * difference between a fort — walled because it is a fort — and a town, walled once
 * it is big enough to be worth the stone.
 */
function walled(rule: RosterRule, importance: number): boolean {
	if (typeof rule.walled === "number") return importance >= rule.walled;
	return rule.walled === true;
}

function pick(rng: Rng, table: readonly (readonly [StructureKind, number])[]): StructureKind {
	if (table.length === 0) return "house";
	const index = rng.weighted(table.map(([, weight]) => weight));
	return table[index]?.[0] ?? "house";
}

/**
 * Takes the whole world rather than the seed alone.
 *
 * The roster lives in the recipe now, and a caller holding only a seed would silently
 * build every settlement from the defaults while looking like it agreed with the world
 * around it. Widening the parameter makes that a compile error at every call site
 * instead — the same reasoning that bundled the seed and the rules into
 * {@link WorldSeed} in the first place.
 */
export function fallbackSettlementSpec(world: WorldSeed, site: MacroSite): SettlementSpec {
	const rng = rngFor(world.seed, "fallback-spec", site.mx, site.my);
	// `none` is the absence of a site rather than a kind of one, so it has no rule and
	// builds nothing. Everything else is guaranteed a rule by `resolveRecipe`.
	const rule = site.kind === "none" ? undefined : world.rules.sites.roster[site.kind];
	if (!rule) return { walled: false, structures: [] };
	const count = structureCount(rule, site.importance);

	const structures: StructureSpec[] = [];
	for (let i = 0; i < count; i++) {
		const kind = pick(rng, rule.structures);
		const def = structureDef(kind);
		structures.push({ kind, size: def.size, importance: def.importance });
	}

	return { walled: walled(rule, site.importance), structures };
}
