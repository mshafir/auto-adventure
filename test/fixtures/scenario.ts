import { hashString } from "../../src/core/rand/hash.js";
import { boundsAround } from "../../src/core/world/bounds.js";
import { isSettlement, type MacroSite, macroSite } from "../../src/core/world/macro.js";
import { worldSeed } from "../../src/core/world/recipe.js";
import type { SiteSpec } from "../../src/core/world/spec.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "../../src/scenario/artifact.js";

/**
 * A small hand-written scenario, for tests that need a prebuilt world.
 *
 * The site ids come from `macroSite` rather than being made up, because an
 * artifact whose ids are not the ones its seed produces is exactly the broken
 * state `verifyArtifact` exists to reject — a fixture that failed that check would
 * make every test using it a test of the rejection path.
 */

export const FIXTURE_SEED = hashString("artifact-test");

/** The first settlement of a seed, so its id is one the world really yields. */
export function findSettlement(seed: number): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(worldSeed(seed), mx, my);
				if (isSettlement(site.kind)) return site;
			}
		}
	}
	throw new Error(`no settlement within 16 macro cells of seed ${seed}`);
}

/**
 * The nearest settlements to the origin, in order, for a scenario with a journey in it.
 *
 * The single-site fixture below is enough for anything about a *place*, and useless for
 * anything about going somewhere: a signpost pointing at the town you are standing in has
 * nothing to say, and neither has a check about whether the story tells you where to walk.
 */
export function findSettlements(seed: number, count: number): MacroSite[] {
	const found: MacroSite[] = [];
	for (let radius = 0; radius < 16 && found.length < count; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				// The ring only, or the inner cells are visited once per radius and the order
				// stops being "nearest first".
				if (Math.max(Math.abs(mx), Math.abs(my)) !== radius) continue;
				const site = macroSite(worldSeed(seed), mx, my);
				if (isSettlement(site.kind)) found.push(site);
			}
		}
	}
	if (found.length < count) {
		throw new Error(`only ${found.length} settlements within 16 macro cells of seed ${seed}`);
	}
	return found.slice(0, count);
}

export function demoSiteSpec(siteId: number): SiteSpec {
	return {
		siteId,
		name: "Thornwick",
		shortName: "Thornwick",
		description: "A wet little town that sells rope.",
		settlement: {
			name: "Thornwick",
			walled: false,
			structures: [
				{ kind: "inn", size: "medium", importance: 5, name: "The Drowned Lamp" },
				{ kind: "house", size: "small", importance: 2 },
			],
		},
		npcs: [
			{
				slot: 0,
				name: "Ilse Marrow",
				role: "innkeeper",
				glyph: "I",
				appearance: "Broad, sunburnt, missing two fingers.",
				persona: "Blunt but not unkind.",
				disposition: 10,
				placement: "doorstep",
				knows: ["The toll clerk has been drinking since the barge sank."],
			},
		],
		hooks: ["A barge went down with the season's rope."],
	};
}

/**
 * Two towns and a story that walks from one to the other.
 *
 * Big enough bounds to hold both, and the spawn at the first — which is the shape every
 * generated world has, and the shape the wayfinding checks and the signpost derivation are
 * about. The second beat deliberately says nothing about where it is, so a test can watch
 * something say it.
 */
export function demoJourneyArtifact(overrides: Partial<ScenarioArtifact> = {}): ScenarioArtifact {
	const [first, second] = findSettlements(FIXTURE_SEED, 2) as [MacroSite, MacroSite];
	const reach = Math.max(
		220,
		Math.round(Math.hypot(second.site.x - first.site.x, second.site.y - first.site.y)) + 80,
	);
	const there = demoSiteSpec(second.id);
	return demoArtifact({
		spawn: { x: first.site.x, y: first.site.y },
		bounds: boundsAround(first.site, reach, { style: "cliffs", thickness: 6 }),
		sites: {
			[String(first.id)]: demoSiteSpec(first.id),
			[String(second.id)]: {
				...there,
				name: "Aldermoor",
				shortName: "Aldermoor",
				settlement: { ...there.settlement, name: "Aldermoor" },
				npcs: [{ ...(there.npcs[0] as SiteSpec["npcs"][number]), name: "Lune Harrowgate" }],
			},
		},
		arc: {
			title: "The Two Tallies",
			premise: "One barge, two tallies, and only one of them true.",
			beats: [
				{
					id: "the-tally",
					order: 0,
					siteId: first.id,
					npcSlot: 0,
					requires: [],
					setsFlag: "arc:the-tally",
					journal: "Ilse says the weighmaster signed for rope that never came ashore.",
				},
				{
					id: "the-clerk",
					order: 1,
					siteId: second.id,
					npcSlot: 0,
					requires: ["arc:the-tally"],
					setsFlag: "arc:the-clerk",
					journal: "The clerk who countersigned it has not been seen since.",
				},
			],
		},
		...overrides,
	});
}

export function demoArtifact(overrides: Partial<ScenarioArtifact> = {}): ScenarioArtifact {
	const site = findSettlement(FIXTURE_SEED);
	return {
		artifactVersion: ARTIFACT_VERSION,
		id: "drowned-archipelago",
		title: "The Drowned Archipelago",
		blurb: "Debt-collectors and rope.",
		brief: { premise: "a drowned archipelago run by debt-collectors" },
		seed: FIXTURE_SEED,
		spawn: { x: site.site.x, y: site.site.y },
		bounds: boundsAround(site.site, 200, { style: "ocean", thickness: 6 }),
		lore: {
			title: "The Drowned Archipelago",
			premise: "The tithe-ships came and the water stayed.",
			era: "the third year of the levy",
			tone: "wry and salt-stained",
			factions: ["The Tithe Office", "The Rope Guild"],
			deities: [],
		},
		regions: {},
		sites: { [String(site.id)]: demoSiteSpec(site.id) },
		authoredWith: { models: { site: "google/gemini-2.5-flash" }, calls: 3, at: "2026-01-01" },
		...overrides,
	};
}
