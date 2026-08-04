import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	demoArtifact,
	demoSiteSpec,
	FIXTURE_SEED,
	findSettlement,
} from "../../test/fixtures/scenario.js";
import { hashString } from "../core/rand/hash.js";
import type { SiteSpec } from "../core/world/spec.js";
import { npcId } from "../core/world/spec.js";
import {
	listScenarios,
	loadScenario,
	readScenarioFile,
	scenarioPath,
	scenarioRoot,
	verifyArtifact,
	writeScenario,
} from "./repo.js";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-scenario-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

const SEED = FIXTURE_SEED;
const SITE = findSettlement(SEED);
const siteSpec = demoSiteSpec;
const artifact = demoArtifact;

describe("writeScenario and readScenarioFile", () => {
	it("round trips an artifact", () => {
		const path = writeScenario(artifact());
		const read = readScenarioFile(path);
		expect(read).toEqual(artifact());
	});

	it("writes where loadScenario looks", () => {
		writeScenario(artifact());
		expect(loadScenario("drowned-archipelago")?.title).toBe("The Drowned Archipelago");
	});

	it("returns undefined for a file that is not there", () => {
		expect(readScenarioFile(scenarioPath("nothing"))).toBeUndefined();
		expect(loadScenario("nothing")).toBeUndefined();
	});

	it("refuses unparseable JSON rather than throwing", () => {
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(scenarioPath("broken"), "{ not json");
		expect(loadScenario("broken")).toBeUndefined();
	});

	it("refuses an artifact from a future build", () => {
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(
			scenarioPath("future"),
			JSON.stringify({ ...artifact(), id: "future", artifactVersion: 99 }),
		);
		expect(loadScenario("future")).toBeUndefined();
	});

	it("refuses a structure kind the generator has no plan for", () => {
		// The closed sets have to stay closed however the file was produced.
		const bad = artifact();
		const spec = bad.sites[String(SITE.id)] as SiteSpec;
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(
			scenarioPath("bad-kind"),
			JSON.stringify({
				...bad,
				id: "bad-kind",
				sites: {
					[String(SITE.id)]: {
						...spec,
						settlement: {
							...spec.settlement,
							structures: [{ kind: "cathedral", size: "large", importance: 5 }],
						},
					},
				},
			}),
		);
		expect(loadScenario("bad-kind")).toBeUndefined();
	});

	it("refuses an id that could escape the scenarios directory", () => {
		const parsed = readScenarioFile(scenarioPath("x"));
		expect(parsed).toBeUndefined();
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(
			scenarioPath("escape"),
			JSON.stringify({ ...artifact(), id: "../../etc/passwd" }),
		);
		expect(loadScenario("escape")).toBeUndefined();
	});
});

describe("listScenarios", () => {
	it("is empty when nothing has been authored", () => {
		expect(listScenarios()).toEqual([]);
	});

	it("lists the good ones and skips the broken", () => {
		writeScenario(artifact());
		writeScenario(artifact({ id: "second", title: "A Second Place" }));
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(scenarioPath("broken"), "{ not json");

		const listed = listScenarios();
		expect(listed.map((s) => s.id)).toEqual(["second", "drowned-archipelago"]);
		expect(listed[0]?.siteCount).toBe(1);
	});
});

describe("verifyArtifact", () => {
	it("accepts an artifact whose sites are real", () => {
		expect(verifyArtifact(artifact())).toEqual([]);
	});

	it("rejects a spec keyed to a site the seed does not produce", () => {
		// The invariant that ruins everything silently. A spec keyed to an id no
		// macro cell yields is unreachable content: the town never gets its name and
		// nothing reports an error.
		const problems = verifyArtifact(artifact({ sites: { "12345": siteSpec(12345) } }));
		expect(problems.join(" ")).toContain("not a site of seed");
	});

	it("rejects an artifact whose seed was changed under it", () => {
		const problems = verifyArtifact(artifact({ seed: hashString("a-different-world") }));
		expect(problems.length).toBeGreaterThan(0);
	});

	it("rejects a site whose key and siteId disagree", () => {
		const problems = verifyArtifact(artifact({ sites: { [String(SITE.id)]: siteSpec(999) } }));
		expect(problems.join(" ")).toContain("carries siteId");
	});

	it("rejects repeated npc slots", () => {
		// Slot is half of every NPC id, so a repeat gives two people one identity.
		const spec = siteSpec(SITE.id);
		const npc = spec.npcs[0];
		if (!npc) throw new Error("fixture has no npc");
		const problems = verifyArtifact(
			artifact({
				sites: { [String(SITE.id)]: { ...spec, npcs: [npc, { ...npc, name: "Other" }] } },
			}),
		);
		expect(problems.join(" ")).toContain("repeats an npc slot");
	});

	it("rejects inverted bounds", () => {
		const problems = verifyArtifact(
			artifact({
				bounds: { minX: 10, minY: 10, maxX: -10, maxY: -10, style: "ocean", thickness: 4 },
			}),
		);
		expect(problems.join(" ")).toContain("bounds are inverted");
	});

	it("accepts an arc whose beats point at real people", () => {
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "The Tithe",
					premise: "Somebody has to pay for the rope.",
					beats: [
						{ id: "a", order: 0, siteId: SITE.id, npcSlot: 0, requires: [], setsFlag: "f1" },
						{ id: "b", order: 1, siteId: SITE.id, npcSlot: 0, requires: ["f1"], setsFlag: "f2" },
					],
				},
			}),
		);
		expect(problems).toEqual([]);
	});

	it("rejects a beat anchored to somebody who is not there", () => {
		// A silent dead end at runtime: the beat never opens, and everything gated
		// behind its flag never opens either, with nothing to tell the player why.
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "T",
					premise: "",
					beats: [{ id: "a", order: 0, siteId: SITE.id, npcSlot: 7, requires: [], setsFlag: "f1" }],
				},
			}),
		);
		expect(problems.join(" ")).toContain("slot 7");
	});

	it("rejects a beat anchored to an unauthored site", () => {
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "T",
					premise: "",
					beats: [{ id: "a", order: 0, siteId: 424242, requires: [], npcSlot: 0, setsFlag: "f1" }],
				},
			}),
		);
		expect(problems.join(" ")).toContain("unauthored site");
	});

	it("rejects a requirement nothing ever sets", () => {
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "T",
					premise: "",
					beats: [
						{ id: "a", order: 0, siteId: SITE.id, npcSlot: 0, requires: [], setsFlag: "f1" },
						{
							id: "b",
							order: 1,
							siteId: SITE.id,
							npcSlot: 0,
							requires: ["never-set"],
							setsFlag: "f2",
						},
					],
				},
			}),
		);
		expect(problems.join(" ")).toContain('waits on "never-set"');
	});

	it("rejects an arc with no way in", () => {
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "T",
					premise: "",
					beats: [
						{ id: "a", order: 0, siteId: SITE.id, npcSlot: 0, requires: ["f2"], setsFlag: "f1" },
						{ id: "b", order: 1, siteId: SITE.id, npcSlot: 0, requires: ["f1"], setsFlag: "f2" },
					],
				},
			}),
		);
		expect(problems.join(" ")).toContain("no beat can open first");
	});

	it("rejects a beat that waits on itself", () => {
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "T",
					premise: "",
					beats: [
						{ id: "a", order: 0, siteId: SITE.id, npcSlot: 0, requires: ["f1"], setsFlag: "f1" },
					],
				},
			}),
		);
		expect(problems.join(" ")).toContain("waits on its own flag");
	});

	it("rejects a duplicated beat id", () => {
		const problems = verifyArtifact(
			artifact({
				arc: {
					title: "T",
					premise: "",
					beats: [
						{ id: "a", order: 0, siteId: SITE.id, npcSlot: 0, requires: [], setsFlag: "f1" },
						{ id: "a", order: 1, siteId: SITE.id, npcSlot: 0, requires: [], setsFlag: "f2" },
					],
				},
			}),
		);
		expect(problems.join(" ")).toContain("defined twice");
	});

	it("accepts a sound tree", () => {
		const anchor = npcId(SITE.id, 0);
		expect(
			verifyArtifact(
				artifact({
					trees: {
						[anchor]: {
							npcId: anchor,
							entry: ["hello"],
							nodes: {
								hello: { id: "hello", speech: "Aye?", choices: [{ text: "Bye.", goto: null }] },
							},
						},
					},
				}),
			),
		).toEqual([]);
	});

	it("rejects a tree whose goto points nowhere", () => {
		// At runtime a dangling goto ends the conversation, so a renamed node turns a
		// branch of dialogue into an abrupt goodbye that looks like a character with
		// nothing to say.
		const anchor = npcId(SITE.id, 0);
		const problems = verifyArtifact(
			artifact({
				trees: {
					[anchor]: {
						npcId: anchor,
						entry: ["hello"],
						nodes: {
							hello: { id: "hello", speech: "Aye?", choices: [{ text: "On.", goto: "gone" }] },
						},
					},
				},
			}),
		);
		expect(problems.join(" ")).toContain("missing node");
	});

	it("rejects a tree belonging to nobody", () => {
		const orphan = npcId(SITE.id, 9);
		const problems = verifyArtifact(
			artifact({
				trees: {
					[orphan]: {
						npcId: orphan,
						entry: ["hello"],
						nodes: {
							hello: { id: "hello", speech: "Aye?", choices: [{ text: "Bye.", goto: null }] },
						},
					},
				},
			}),
		);
		expect(problems.join(" ")).toContain("belongs to nobody");
	});

	it("rejects a conversation with no way out", () => {
		const anchor = npcId(SITE.id, 0);
		const problems = verifyArtifact(
			artifact({
				trees: {
					[anchor]: {
						npcId: anchor,
						entry: ["a"],
						nodes: {
							a: { id: "a", speech: "One.", choices: [{ text: "On.", goto: "b" }] },
							b: { id: "b", speech: "Two.", choices: [{ text: "Back.", goto: "a" }] },
						},
					},
				},
			}),
		);
		expect(problems.join(" ")).toContain("no way to end");
	});

	it("rejects a region whose key and id disagree", () => {
		const problems = verifyArtifact(
			artifact({
				regions: {
					"7": {
						id: "9",
						name: "The Wet Reach",
						blurb: "Low islands.",
						tone: "wry",
						culture: "Ropemakers.",
						lore: [],
						ambient: [],
					},
				},
			}),
		);
		expect(problems.join(" ")).toContain("carries id");
	});
});
