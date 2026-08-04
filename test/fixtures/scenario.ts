import { hashString } from "../../src/core/rand/hash.js";
import { boundsAround } from "../../src/core/world/bounds.js";
import { isSettlement, type MacroSite, macroSite } from "../../src/core/world/macro.js";
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
				const site = macroSite(seed, mx, my);
				if (isSettlement(site.kind)) return site;
			}
		}
	}
	throw new Error(`no settlement within 16 macro cells of seed ${seed}`);
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
