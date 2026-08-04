import { fallbackSettlementSpec } from "../../core/gen/features/fallback-spec.js";
import { rngFor } from "../../core/rand/rng.js";
import type { RegionContext, SiteContext } from "../../core/world/context.js";
import type { MacroSite } from "../../core/world/macro.js";
import { personName, placeName, regionName } from "../../core/world/names.js";
import type { NpcSpec, RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";

/**
 * The world with no director.
 *
 * Not a stub: `--no-ai` and "your key stopped working" produce exactly this, and
 * it has to be a game rather than an error state. Every place gets a name, every
 * settlement gets a handful of people with roles and something to say. What it
 * lacks is a story tying them together — which is precisely what the LLM is for.
 */

export function fallbackLore(): WorldLore {
	return {
		title: "The Long Weather",
		premise:
			"The old roads still run between the holdfasts, though fewer people walk them each year. " +
			"Something in the weather has turned, and the villages have begun keeping their own counsel.",
		era: "the late years of a long decline",
		tone: "weatherbeaten and plainspoken",
		factions: ["the Roadwardens", "the Hollow Assembly", "the Salt Factors"],
		deities: ["the Patient Sister", "Ord of the Nine Gates"],
	};
}

export function fallbackRegion(seed: number, context: RegionContext): RegionSpec {
	const name = regionName(seed, context.regionId, context.biome);
	return {
		id: String(context.regionId),
		name,
		blurb: `${name} is ${context.biomeName.toLowerCase()} country, and keeps to itself.`,
		tone: "quiet",
		culture: "smallholders and road-traders",
		lore: [],
		ambient: [
			`The wind moves across the ${context.biomeName.toLowerCase()}.`,
			"Somewhere behind you, a bird you cannot name calls twice and stops.",
			"The road here is older than anything built beside it.",
		],
	};
}

/** Roles worth standing outside, per structure kind. */
const ROLE_BY_KIND: Readonly<Record<string, readonly [string, NpcSpec["placement"]]>> = {
	shop: ["shopkeeper", "doorstep"],
	inn: ["innkeeper", "doorstep"],
	smithy: ["blacksmith", "doorstep"],
	temple: ["priest", "doorstep"],
	apothecary: ["apothecary", "doorstep"],
	barracks: ["guard", "gate"],
	stable: ["stablehand", "yard"],
	mill: ["miller", "yard"],
	farmhouse: ["farmer", "yard"],
	warehouse: ["factor", "yard"],
};

const WANDERERS: readonly (readonly [string, NpcSpec["placement"]])[] = [
	["carter", "well"],
	["herbalist", "stall"],
	["old resident", "bench"],
	["messenger", "gate"],
];

export function fallbackSite(seed: number, site: MacroSite, context: SiteContext): SiteSpec {
	const settlement = fallbackSettlementSpec(seed, site);
	const name = placeName(seed, site.id, site.kind, context.biome);
	const rng = rngFor(seed, "fallback-npcs", site.mx, site.my);

	// One NPC per notable structure, then a couple of people in the square, up to
	// a cap that keeps a hamlet from feeling like a city.
	const cap = site.kind === "town" ? 5 : site.kind === "village" ? 4 : site.kind === "camp" ? 1 : 2;
	const npcs: NpcSpec[] = [];
	const seen = new Set<string>();

	for (const structure of settlement.structures) {
		if (npcs.length >= cap) break;
		const role = ROLE_BY_KIND[structure.kind];
		if (!role || seen.has(role[0])) continue;
		seen.add(role[0]);
		npcs.push(makeNpc(seed, site, npcs.length, role[0], role[1]));
	}
	while (npcs.length < Math.min(cap, 2)) {
		const [role, placement] = WANDERERS[rng.int(WANDERERS.length)] ?? WANDERERS[0]!;
		if (seen.has(role)) {
			// Only a handful of wanderers exist; stop rather than loop forever.
			if (seen.size >= WANDERERS.length) break;
			continue;
		}
		seen.add(role);
		npcs.push(makeNpc(seed, site, npcs.length, role, placement));
	}

	return {
		siteId: site.id,
		name,
		shortName: name.split(" ")[0] ?? name,
		description: `A ${site.kind} of ${context.biomeName.toLowerCase()}, ${
			context.roadCount > 1 ? "where two roads meet" : "at the end of a road"
		}.`,
		settlement: { ...settlement, name },
		npcs,
		hooks: [],
	};
}

function makeNpc(
	seed: number,
	site: MacroSite,
	slot: number,
	role: string,
	placement: NpcSpec["placement"],
): NpcSpec {
	return {
		slot,
		name: personName(seed, site.id, slot),
		role,
		glyph: (role[0] ?? "p").toUpperCase(),
		appearance: `A ${role}, dressed for the work and the weather.`,
		persona: `Plainspoken. Talks about the ${role === "guard" ? "road" : "trade"} and little else.`,
		disposition: 0,
		placement,
		knows: [],
	};
}
