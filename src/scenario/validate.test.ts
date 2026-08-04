import { describe, expect, it } from "vitest";
import { demoArtifact, demoSiteSpec } from "../../test/fixtures/scenario.js";
import type { ScenarioArtifact } from "./artifact.js";
import { buildPassability, hasErrors, validateArtifact } from "./validate.js";

/**
 * The offline validation pass.
 *
 * These are the checks a live director structurally cannot make, so they are worth
 * proving: by the time a live call could ask whether the anchor of a beat is
 * standing somewhere reachable, the player is already there.
 */

const BASE = demoArtifact();
const SITE_KEY = Object.keys(BASE.sites)[0] as string;
const SITE_ID = Number(SITE_KEY);

const NPC = demoSiteSpec(SITE_ID).npcs[0];
if (!NPC) throw new Error("fixture has no npc");

function withSite(changes: Partial<ReturnType<typeof demoSiteSpec>>): ScenarioArtifact {
	const spec = demoSiteSpec(SITE_ID);
	return demoArtifact({ sites: { [SITE_KEY]: { ...spec, ...changes } } });
}

function messages(artifact: ScenarioArtifact): string {
	return validateArtifact(artifact)
		.map((finding) => `${finding.severity}: ${finding.message}`)
		.join("\n");
}

// Generating every chunk of a bounded world is the work this pass exists to do, so
// these tests are slow by nature rather than by accident: the default five seconds
// is not a budget the real thing can be held to.
const SLOW = { timeout: 60_000 };

describe("buildPassability", SLOW, () => {
	it("covers the whole bounded world", () => {
		const grid = buildPassability(BASE);
		expect(grid.w).toBeGreaterThan(BASE.bounds.maxX - BASE.bounds.minX);
		expect(grid.h).toBeGreaterThan(BASE.bounds.maxY - BASE.bounds.minY);
		// A world that is entirely wall would make every path check vacuous.
		expect(grid.passable.some((cell) => cell === 1)).toBe(true);
	});

	it("is closed at the boundary", () => {
		const grid = buildPassability(BASE);
		const outside = { x: BASE.bounds.maxX + 30, y: BASE.spawn.y };
		const gx = outside.x - grid.x;
		const gy = outside.y - grid.y;
		if (gx >= 0 && gy >= 0 && gx < grid.w && gy < grid.h) {
			expect(grid.passable[gy * grid.w + gx]).toBe(0);
		}
	});
});

describe("validateArtifact", SLOW, () => {
	it("passes a sound scenario", () => {
		const findings = validateArtifact(BASE);
		expect(hasErrors(findings), messages(BASE)).toBe(false);
	});

	it("catches an NPC standing at an anchor that was never built", () => {
		// The check no live director can make. `placement` comes from a closed set, but
		// whether *this* settlement has one of those anchors depends on its layout,
		// which only the generator knows. A fort of this size lays down eight of the
		// nine kinds and no yard, so a yard is a person standing nowhere.
		const broken = withSite({ npcs: [{ ...NPC, placement: "yard" }] });
		expect(messages(broken)).toContain("that was not built");
		expect(hasErrors(validateArtifact(broken))).toBe(true);
	});

	it("accepts an anchor the settlement does lay down", () => {
		expect(messages(withSite({ npcs: [{ ...NPC, placement: "well" }] }))).not.toContain(
			"that was not built",
		);
	});

	it("warns when a person is assigned a building that did not fit", () => {
		const broken = withSite({
			npcs: [{ ...NPC, structureName: "The Cathedral of Nothing" }],
		});
		expect(messages(broken)).toContain("which was not built");
	});

	it("warns when more structures were asked for than can fit", () => {
		const spec = demoSiteSpec(SITE_ID);
		const crowded = withSite({
			settlement: {
				...spec.settlement,
				structures: Array.from({ length: 24 }, (_, i) => ({
					kind: "house" as const,
					size: "small" as const,
					importance: 1,
					name: `House ${i}`,
				})),
			},
		});
		expect(messages(crowded)).toContain("fitted");
	});

	it("rejects a spawn inside the boundary band", () => {
		const broken = demoArtifact({ spawn: { x: BASE.bounds.maxX, y: BASE.bounds.maxY } });
		expect(messages(broken)).toContain("boundary band");
		expect(hasErrors(validateArtifact(broken))).toBe(true);
	});

	it("warns when a quest asks for a place that does not exist", () => {
		const artifact = demoArtifact({
			arc: {
				title: "T",
				premise: "",
				beats: [
					{
						id: "a",
						order: 0,
						siteId: SITE_ID,
						npcSlot: 0,
						requires: [],
						setsFlag: "f1",
						quest: {
							id: "q",
							name: "Go there",
							description: "",
							objectives: [{ kind: "reach", target: "Atlantis", done: false }],
						},
					},
				],
			},
		});
		expect(messages(artifact)).toContain('nowhere here is called "Atlantis"');
	});

	it("accepts a quest asking for a place that does exist", () => {
		const artifact = demoArtifact({
			arc: {
				title: "T",
				premise: "",
				beats: [
					{
						id: "a",
						order: 0,
						siteId: SITE_ID,
						npcSlot: 0,
						requires: [],
						setsFlag: "f1",
						quest: {
							id: "q",
							name: "Go there",
							description: "",
							objectives: [{ kind: "reach", target: "Thornwick", done: false }],
						},
					},
				],
			},
		});
		expect(messages(artifact)).not.toContain("nowhere here is called");
	});

	it("measures the walking the story asks for", () => {
		// A one-beat story in the town you start in is far short of what a medium
		// scenario promises, and saying so is the point of the check.
		const artifact = demoArtifact({
			brief: { ...BASE.brief, duration: "long" },
			arc: {
				title: "T",
				premise: "",
				beats: [{ id: "a", order: 0, siteId: SITE_ID, npcSlot: 0, requires: [], setsFlag: "f1" }],
			},
		});
		expect(messages(artifact)).toContain("tiles of walking");
	});

	it("notes settlements the story ignores", () => {
		const artifact = demoArtifact({
			arc: {
				title: "T",
				premise: "",
				beats: [{ id: "a", order: 0, siteId: SITE_ID, npcSlot: 0, requires: [], setsFlag: "f1" }],
			},
			sites: {
				...BASE.sites,
				// A second town nobody in the story goes to.
				// Three structures, because the check deliberately ignores hamlets.
				"999999": {
					...demoSiteSpec(999999),
					name: "Ashford",
					settlement: {
						name: "Ashford",
						walled: false,
						structures: [
							{ kind: "inn", size: "medium", importance: 5 },
							{ kind: "house", size: "small", importance: 2 },
							{ kind: "house", size: "small", importance: 1 },
						],
					},
				},
			},
		});
		// The bogus site also fails the seed check, which is the more serious finding.
		expect(messages(artifact)).toContain("Ashford");
	});

	it("warns about a one-line conversation", () => {
		const anchor = `npc:${SITE_ID >>> 0}:0`;
		const artifact = demoArtifact({
			trees: {
				[anchor]: {
					npcId: anchor,
					entry: ["only"],
					nodes: { only: { id: "only", speech: "Aye.", choices: [{ text: "Bye.", goto: null }] } },
				},
			},
		});
		expect(messages(artifact)).toContain("single line");
	});
});
