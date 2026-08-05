import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
import { regionContext, siteContext } from "../../core/world/context.js";
import { isSettlement, type MacroSite, macroSite } from "../../core/world/macro.js";
import { worldSeed } from "../../core/world/recipe.js";
import { fallbackLore, fallbackRegion } from "./fallback.js";
import { lorePrompt, regionPrompt, sitePrompt } from "./prompt.js";

const SEED = hashString("prompt-test");

function findSite(seed: number): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(worldSeed(seed), mx, my);
				if (isSettlement(site.kind)) return site;
			}
		}
	}
	throw new Error("no settlement within 16 macro cells");
}

const LORE = fallbackLore();
const SITE = findSite(SEED);
const SITE_CONTEXT = siteContext(worldSeed(SEED), SITE);
const REGION_CONTEXT = regionContext(worldSeed(SEED), SITE.regionId, SITE.site);
const REGION = fallbackRegion(SEED, REGION_CONTEXT);

const BRIEF: ScenarioBrief = {
	premise: "a drowned archipelago run by debt-collectors",
	storyline: "the player is hunting a sibling who joined the tithe-ships",
	tone: "wry and salt-stained",
	avoid: "dragons",
};

describe("lorePrompt", () => {
	it("asks for the default premise when nobody briefed the world", () => {
		const prompt = lorePrompt();
		expect(prompt).toContain("low-magic");
		expect(prompt).not.toContain("author's brief");
	});

	it("is unchanged by a brief with nothing in it", () => {
		// Every world that predates briefs has to keep generating exactly as it did.
		// An all-blank brief reaching the prompt would silently reword the premise
		// for all of them.
		expect(lorePrompt({})).toBe(lorePrompt());
		expect(lorePrompt({ premise: "   " })).toBe(lorePrompt());
	});

	it("follows a brief instead of the default premise", () => {
		const prompt = lorePrompt(BRIEF);
		expect(prompt).toContain("a drowned archipelago run by debt-collectors");
		expect(prompt).toContain("hunting a sibling");
		expect(prompt).toContain("Avoid: dragons");
		// A brief asking for sorcery should not have to argue with the default.
		expect(prompt).not.toContain("low-magic");
	});

	it("keeps the scale guidance, which is about the game rather than the genre", () => {
		expect(lorePrompt(BRIEF)).toContain("blacksmith");
		expect(lorePrompt(BRIEF)).toContain("traveller on foot");
	});
});

describe("regionPrompt", () => {
	it("is unchanged by an absent or empty brief", () => {
		const plain = regionPrompt(LORE, REGION_CONTEXT);
		expect(regionPrompt(LORE, REGION_CONTEXT, {})).toBe(plain);
		expect(plain).not.toContain("Author's intent");
	});

	it("restates the storyline and the constraints", () => {
		const prompt = regionPrompt(LORE, REGION_CONTEXT, BRIEF);
		expect(prompt).toContain("Author's intent");
		expect(prompt).toContain("hunting a sibling");
		expect(prompt).toContain("Avoid: dragons");
	});

	it("does not restate the premise, which is already inside the lore", () => {
		// Repeating it invites the model to re-derive the world rather than build on
		// it, and it is paid for on every region and every settlement.
		const prompt = regionPrompt(LORE, REGION_CONTEXT, {
			premise: "a drowned archipelago run by debt-collectors",
			setting: "the tithe-ships",
		});
		expect(prompt).not.toContain("Author's intent");
		expect(prompt).not.toContain("drowned archipelago");
	});
});

describe("sitePrompt", () => {
	it("is unchanged by an absent or empty brief", () => {
		const plain = sitePrompt(LORE, REGION, SITE_CONTEXT);
		expect(sitePrompt(LORE, REGION, SITE_CONTEXT, {})).toBe(plain);
		expect(plain).not.toContain("Author's intent");
	});

	it("carries the storyline so hooks can point at it", () => {
		const prompt = sitePrompt(LORE, REGION, SITE_CONTEXT, BRIEF);
		expect(prompt).toContain("Author's intent");
		expect(prompt).toContain("hunting a sibling");
	});

	it("still states the building budget the engine decided", () => {
		// The brief must never displace the facts: the engine owns the layout.
		const prompt = sitePrompt(LORE, REGION, SITE_CONTEXT, BRIEF);
		expect(prompt).toContain(`Room for about ${SITE_CONTEXT.buildingBudget} buildings`);
		expect(prompt).toContain(`Give exactly ${SITE_CONTEXT.buildingBudget} structures`);
	});
});
