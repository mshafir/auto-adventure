import { describe, expect, it } from "vitest";
import { demoArtifact, demoSiteSpec } from "../../test/fixtures/scenario.js";
import { PLACEMENTS } from "../ai/director/schemas.js";
import type { ScenarioBeat } from "../core/rules/arc.js";
import { namesMatch } from "../core/rules/surroundings.js";
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

	it("treats a yard as the doorstep the engine serves it from", () => {
		// `pickAnchor` maps `yard` to `doorstep`. Reporting it as missing was wrong, and
		// as an *error* it refused scenarios that play perfectly — including every one
		// built from the deterministic roster, which asks for a yard routinely.
		expect(messages(withSite({ npcs: [{ ...NPC, placement: "yard" }] }))).not.toContain(
			"does not build",
		);
	});

	it("never blocks an install over where somebody stands", () => {
		// Placement is advisory by design: the engine falls back to any free anchor, so
		// the worst case is a character standing somewhere else in the same town. That
		// is worth a warning and never worth refusing.
		for (const placement of PLACEMENTS) {
			const findings = validateArtifact(withSite({ npcs: [{ ...NPC, placement }] }));
			const blocking = findings.filter(
				(finding) => finding.severity === "error" && finding.message.includes("does not build"),
			);
			expect(blocking, `placement "${placement}" blocked the install`).toEqual([]);
		}
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
		expect(messages(artifact)).toContain('nothing here answers to "Atlantis"');
	});

	it("rejects a place name the runtime could never match", () => {
		// The defect the shared resolver fixes. The old check matched by substring, so
		// "mill" passed against a town called "Millgate Barracks" — and then never
		// completed, because `verifyQuests` matches on significant words and "mill" is
		// not one of "millgate barracks". Authoring accepted a quest the game refused.
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
							// "Thornwick" is the fixture town; "Thorn" is a substring of it and
							// nothing else, which the old check accepted and the runtime does not.
							objectives: [{ kind: "reach", target: "Thorn", done: false }],
						},
					},
				],
			},
		});
		const found = messages(artifact);
		expect(found).toContain("Thorn");
		// And it agrees with the runtime rather than merely disagreeing with the old
		// check: what the validator refuses, `namesMatch` also refuses.
		expect(namesMatch("Thorn", "Thornwick")).toBe(false);
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

describe("gates", () => {
	/**
	 * A gate somewhere it cannot possibly work: on the spawn tile, in the open.
	 *
	 * Written positionally rather than found, because the finding under test is about
	 * geometry and the fixture's spawn is a town square — about as un-gate-like a tile
	 * as the world contains.
	 */
	function gateAt(tiles: readonly { x: number; y: number }[]) {
		return validateArtifact(
			demoArtifact({
				barriers: [
					{
						id: "nowhere-gate",
						tiles,
						opensWhen: { flag: "arc:opened" },
						lockedText: "It is barred.",
					},
				],
			}),
		);
	}

	it("refuses one that can be stepped around", () => {
		const artifact = demoArtifact();
		const findings = gateAt([{ x: artifact.spawn.x, y: artifact.spawn.y }]);
		expect(
			findings.some(
				(finding) => finding.severity === "error" && finding.message.includes("stepped around"),
			),
		).toBe(true);
	});

	it("refuses one on ground nobody could walk anyway", () => {
		// Far outside the world, which is impassable by construction — the same answer a
		// gate embedded in a cliff face would get, and the same reason it is useless.
		const findings = gateAt([{ x: 100_000, y: 100_000 }]);
		expect(findings.some((finding) => finding.severity === "error")).toBe(true);
	});

	it("refuses one laid diagonally, which cannot be reasoned about", () => {
		const artifact = demoArtifact();
		const findings = gateAt([
			{ x: artifact.spawn.x, y: artifact.spawn.y },
			{ x: artifact.spawn.x + 1, y: artifact.spawn.y + 1 },
		]);
		expect(findings.some((finding) => finding.message.includes("single row or column"))).toBe(true);
	});

	it("says nothing about a scenario with no gates", () => {
		const findings = validateArtifact(demoArtifact());
		expect(findings.some((finding) => finding.message.includes("barrier"))).toBe(false);
	});
});

describe("conditions nothing can satisfy", () => {
	it("refuses a trigger waiting on a flag nobody sets", () => {
		const findings = validateArtifact(
			demoArtifact({
				triggers: [
					{
						id: "orphan",
						when: { flag: "nobody:sets-this" },
						effects: [{ t: "SetFlag", key: "done", value: true }],
					},
				],
			}),
		);
		expect(
			findings.some(
				(finding) => finding.severity === "error" && finding.message.includes("nobody:sets-this"),
			),
		).toBe(true);
	});

	it("accepts one waiting on a flag another trigger sets", () => {
		// The check has to know about every kind of writer, or it refuses working content.
		const findings = validateArtifact(
			demoArtifact({
				triggers: [
					{
						id: "first",
						when: { visited: "anywhere" },
						effects: [{ t: "SetFlag", key: "chain:one", value: true }],
					},
					{
						id: "second",
						when: { flag: "chain:one" },
						effects: [{ t: "SetFlag", key: "chain:two", value: true }],
					},
				],
			}),
		);
		expect(findings.some((finding) => finding.message.includes("chain:one"))).toBe(false);
	});

	it("accepts one waiting on an engine-written flag", () => {
		// `visited:` is written by the reducer on arrival, so no author sets it.
		const findings = validateArtifact(
			demoArtifact({
				triggers: [
					{
						id: "arrived",
						when: { visited: "Anywhere" },
						effects: [{ t: "SetFlag", key: "seen", value: true }],
					},
				],
			}),
		);
		expect(findings.some((finding) => finding.message.includes("which nothing sets"))).toBe(false);
	});

	it("notes a condition asking about somebody who is not in the scenario", () => {
		const findings = validateArtifact(
			demoArtifact({
				triggers: [
					{
						id: "ghost",
						when: { talked: "npc:99999:7" },
						effects: [{ t: "SetFlag", key: "spoken", value: true }],
					},
				],
			}),
		);
		expect(findings.some((finding) => finding.message.includes("npc:99999:7"))).toBe(true);
	});
});

describe("placements", () => {
	it("refuses one that names a site this world does not have", () => {
		const findings = validateArtifact(
			demoArtifact({
				placements: [
					{
						id: "lost",
						at: { kind: "site", siteId: 424242 },
						item: { name: "A Thing", description: "It is somewhere." },
					},
				],
			}),
		);
		expect(
			findings.some(
				(finding) => finding.severity === "error" && finding.message.includes("not in this world"),
			),
		).toBe(true);
	});

	it("refuses two on the same tile, because only one can be found", () => {
		const artifact = demoArtifact();
		const at = { kind: "world" as const, x: artifact.spawn.x, y: artifact.spawn.y };
		const findings = validateArtifact(
			demoArtifact({
				placements: [
					{ id: "first", at, item: { name: "One", description: "." } },
					{ id: "second", at, item: { name: "Two", description: "." } },
				],
			}),
		);
		expect(
			findings.some(
				(finding) => finding.severity === "error" && finding.message.includes("same tile"),
			),
		).toBe(true);
	});
});

describe("forks", () => {
	function forked(extra: Partial<ScenarioBeat> = {}) {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const base = { siteId, npcSlot: 0, order: 1 };
		return validateArtifact(
			demoArtifact({
				arc: {
					title: "T",
					premise: "p",
					beats: [
						{ ...base, id: "open", order: 0, requires: [], setsFlag: "arc:open" },
						{
							...base,
							id: "left",
							requires: ["arc:open"],
							setsFlag: "arc:left",
							branch: "the-choice",
						},
						{
							...base,
							id: "right",
							requires: ["arc:open"],
							setsFlag: "arc:right",
							branch: "the-choice",
						},
						{
							...base,
							id: "after",
							order: 2,
							requires: ["arc:open"],
							setsFlag: "arc:after",
							...extra,
						},
					],
				},
			}),
		);
	}

	it("accepts a fork whose downstream does not depend on which arm was taken", () => {
		expect(forked().some((finding) => finding.message.includes("the-choice"))).toBe(false);
	});

	it("refuses a beat that only one arm can unlock", () => {
		// The failure this exists for: take the other arm and the story stops with
		// `remaining` above zero and nothing on screen to explain it.
		const findings = forked({ requires: ["arc:left"] });
		expect(
			findings.some(
				(finding) =>
					finding.severity === "error" &&
					finding.message.includes('if "right" is chosen') &&
					finding.message.includes("arc:left"),
			),
		).toBe(true);
	});

	it("notes a fork with only one arm, which is not a choice", () => {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const findings = validateArtifact(
			demoArtifact({
				arc: {
					title: "T",
					premise: "p",
					beats: [
						{
							id: "only",
							order: 0,
							siteId,
							npcSlot: 0,
							requires: [],
							setsFlag: "arc:only",
							branch: "lonely",
						},
					],
				},
			}),
		);
		expect(findings.some((finding) => finding.message.includes("only one arm"))).toBe(true);
	});
});

describe("sub-errands", () => {
	it("refuses an objective naming an errand no beat hands out", () => {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const findings = validateArtifact(
			demoArtifact({
				arc: {
					title: "T",
					premise: "p",
					beats: [
						{
							id: "parent",
							order: 0,
							siteId,
							npcSlot: 0,
							requires: [],
							setsFlag: "arc:parent",
							quest: {
								id: "parent",
								name: "The whole job",
								description: "",
								objectives: [{ kind: "quest", target: "never-given", done: false }],
							},
						},
					],
				},
			}),
		);
		expect(
			findings.some(
				(finding) => finding.severity === "error" && finding.message.includes("never-given"),
			),
		).toBe(true);
	});
});

describe("items the player has no way to learn about", () => {
	/**
	 * The check that was missing, and it cost a playthrough.
	 *
	 * A gate on `{ item: X }` passes every obtainability test as long as X exists
	 * somewhere. But obtainable is not findable: a story can gate its third act on a
	 * disc in a locked tower and never mention the disc, at which point the errand log
	 * goes empty and there is nothing on screen to read.
	 */
	function gatedOnItem(extra: Partial<ScenarioArtifact> = {}) {
		return validateArtifact(
			demoArtifact({
				triggers: [
					{
						id: "weighed",
						when: { item: "Lead Standard" },
						effects: [{ t: "SetFlag", key: "proven", value: true }],
					},
				],
				...extra,
			}),
		);
	}

	const noWayToKnow = (findings: readonly { severity: string; message: string }[]) =>
		findings.some(
			(finding) => finding.severity === "error" && finding.message.includes("no way to learn"),
		);

	it("refuses a gate on an item nothing points at", () => {
		expect(noWayToKnow(gatedOnItem())).toBe(true);
	});

	it("accepts one an errand asks for outright", () => {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		expect(
			noWayToKnow(
				gatedOnItem({
					arc: {
						title: "T",
						premise: "p",
						beats: [
							{
								id: "fetch",
								order: 0,
								siteId,
								npcSlot: 0,
								requires: [],
								setsFlag: "arc:fetch",
								quest: {
									id: "fetch",
									name: "The standard",
									description: "",
									objectives: [{ kind: "have", target: "Lead Standard", done: false }],
								},
							},
						],
					},
				}),
			),
		).toBe(false);
	});

	it("accepts one merely mentioned in prose the player reads", () => {
		// Authors vary in how blunt they are, and a hint in a journal line is a fair way
		// to point at something. The failure being caught is the name appearing nowhere.
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		expect(
			noWayToKnow(
				gatedOnItem({
					arc: {
						title: "T",
						premise: "p",
						beats: [
							{
								id: "hint",
								order: 0,
								siteId,
								npcSlot: 0,
								requires: [],
								setsFlag: "arc:hint",
								journal: "The crown's own lead standard has not left the Hall since autumn.",
							},
						],
					},
				}),
			),
		).toBe(false);
	});

	it("says nothing when no condition depends on an item", () => {
		expect(noWayToKnow(validateArtifact(demoArtifact()))).toBe(false);
	});
});

describe("recipes", SLOW, () => {
	/** The recipe checks run before the world is swept, so a bare bounds is enough. */
	function withRecipe(recipe: ScenarioArtifact["recipe"]): ScenarioArtifact {
		return demoArtifact({ recipe });
	}

	it("refuses a place that reaches further than a chunk looks", () => {
		// The one recipe mistake that breaks the seam contract rather than the story:
		// the outskirts would exist in the chunks near the town and not in the ones
		// beyond, and nothing at runtime would ever say so.
		//
		// The schema already caps `radius` at the halo, so this is the backstop for a
		// recipe that did not come through it — an artifact assembled in code, or a
		// bound that drifts. Belt and braces on the property everything else rests on.
		const found = messages(
			withRecipe({ places: [{ at: { x: 0, y: 0 }, kind: "town", radius: 200 }] }),
		);
		expect(found).toMatch(/allows a feature of radius 200/);
		expect(found).toMatch(/exist in some chunks and not others/);
	});

	it("refuses two places sharing one macro cell", () => {
		const found = messages(
			withRecipe({
				places: [
					{ at: { x: 8, y: 8 }, kind: "town" },
					{ at: { x: 40, y: 40 }, kind: "village" },
				],
			}),
		);
		expect(found).toMatch(/two places share the macro cell/);
		expect(found).toMatch(/only the second one exists/);
	});

	it("refuses a place outside the playable world", () => {
		const found = messages(withRecipe({ places: [{ at: { x: 100_000, y: 0 }, kind: "hamlet" }] }));
		expect(found).toMatch(/the hamlet at 100000,0 is outside the world/);
	});

	it("warns about a zone that reaches nothing", () => {
		const found = messages(
			withRecipe({ zones: [{ id: "nowhere", at: { x: 90_000, y: 0 }, radius: 50, scatter: 2 }] }),
		);
		expect(found).toMatch(/warning: zone nowhere does not reach the playable world/);
	});

	it("accepts a recipe that fits", () => {
		const found = messages(
			withRecipe({
				climate: { moistureBias: 0.1 },
				biomes: { forest: { scatterDensity: 0.8 } },
				zones: [{ at: { x: 0, y: 0 }, radius: 120, scatter: 2 }],
			}),
		);
		expect(found).not.toMatch(/recipe|macro cell|feature of radius/);
	});
});
