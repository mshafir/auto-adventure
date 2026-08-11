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

// Redirected explicitly rather than through `AUTO_ADVENTURE_HOME`: scenarios live
// in the repository now, so without this the suite would read — and `writeScenario`
// would write — the real `.scenarios/` directory that is under version control.
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-scenario-"));
	process.env.AUTO_ADVENTURE_SCENARIOS = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_SCENARIOS;
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

	/**
	 * The settings a generated world is asked for before it exists.
	 *
	 * All three are decided on the config page and then have to survive being written to
	 * disk and read back, because the file is the only record: a generated scenario is
	 * replayed from `.scenarios`, not from whatever the player answered that day.
	 */
	it("keeps the clock, the look and the improvise flag a generated world was given", () => {
		const path = writeScenario({
			...artifact(),
			time: { enabled: false },
			tiles: "gramarye",
			liveInGame: true,
		});
		const read = readScenarioFile(path);
		expect(read?.time).toEqual({ enabled: false });
		expect(read?.tiles).toBe("gramarye");
		expect(read?.liveInGame).toBe(true);
	});

	it("treats a world that said nothing about improvising as one that does not", () => {
		// Which is every hand-written scenario. `prebuilt` meant "never calls a model"
		// before this existed, and it has to go on meaning that where nobody said otherwise.
		const read = readScenarioFile(writeScenario(artifact()));
		expect(read?.liveInGame).toBeUndefined();
	});

	it("keeps a structure's identity and its required flag through a round trip", () => {
		const site = findSettlement(FIXTURE_SEED);
		const spec = demoSiteSpec(site.id);
		const built = artifact({
			sites: {
				[String(site.id)]: {
					...spec,
					settlement: {
						...spec.settlement,
						structures: [
							{
								kind: "hall",
								size: "medium",
								importance: 5,
								name: "The Counting House",
								id: "counting-house",
								required: true,
							},
						],
					},
				},
			},
		});

		const path = writeScenario(built);
		const read = readScenarioFile(path);

		const structure = read?.sites[String(site.id)]?.settlement.structures[0];
		expect(structure?.id).toBe("counting-house");
		expect(structure?.required).toBe(true);
	});

	/**
	 * Two structures sharing an explicit id used to be silently possible, and
	 * `settlement.ts` keys both its plot request and its spec lookup by that string — a
	 * repeat lets one plot's assignment answer to the *other* entry's spec, and a required
	 * building can vanish into filler with nothing downstream reporting it wrong. Refused
	 * here rather than left for the generator to trip over.
	 */
	it("refuses two structures that share an explicit id", () => {
		const bad = artifact();
		const spec = bad.sites[String(SITE.id)] as SiteSpec;
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(
			scenarioPath("dup-structure-id"),
			JSON.stringify({
				...bad,
				id: "dup-structure-id",
				sites: {
					[String(SITE.id)]: {
						...spec,
						settlement: {
							...spec.settlement,
							structures: [
								{ kind: "house", size: "small", importance: 5, id: "dup" },
								{ kind: "house", size: "small", importance: 5, id: "dup" },
							],
						},
					},
				},
			}),
		);
		expect(loadScenario("dup-structure-id")).toBeUndefined();
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

/**
 * A scenario names its pack; the tables have to be *there* by the time anything
 * downstream sees the artifact.
 *
 * The reason that matters is not tidiness. `buildSession` persists whatever
 * `content` it is handed straight into the save, so resolving late — or not at all —
 * would give a running world a pointer to a file instead of the names it is using,
 * and deleting the pack would rename everybody the player had already met.
 */
describe("a scenario's pack reference", () => {
	let packs: string;

	beforeEach(() => {
		packs = mkdtempSync(join(tmpdir(), "auto-adventure-packs-"));
		process.env.AUTO_ADVENTURE_PACKS = packs;
		writeFileSync(
			join(packs, "borrowed.json"),
			JSON.stringify({
				id: "borrowed",
				names: { given: ["Ott", "Bevan"], heads: { wet: ["sump"] } },
				appearance: { cooper: "hands like bark" },
			}),
		);
	});

	afterEach(() => {
		delete process.env.AUTO_ADVENTURE_PACKS;
		rmSync(packs, { recursive: true, force: true });
	});

	it("arrives resolved, so nothing downstream has to know a reference existed", () => {
		writeScenario({ ...artifact(), pack: "borrowed" });
		const read = loadScenario("drowned-archipelago");
		expect(read?.content?.names?.given).toEqual(["Ott", "Bevan"]);
		expect(read?.content?.appearance?.cooper).toBe("hands like bark");
		// The reference itself survives, so the file can be rewritten from what was read.
		expect(read?.pack).toBe("borrowed");
	});

	it("lets the scenario's own tables win over the pack it borrows", () => {
		writeScenario({
			...artifact(),
			pack: "borrowed",
			content: { appearance: { cooper: "a coil of rope over one shoulder" } },
		});
		const content = loadScenario("drowned-archipelago")?.content;
		expect(content?.appearance?.cooper).toBe("a coil of rope over one shoulder");
		// And the tables it said nothing about still come through.
		expect(content?.names?.given).toEqual(["Ott", "Bevan"]);
	});

	it("refuses a scenario whose pack is missing, rather than quietly using defaults", () => {
		// A world of correctly-placed towns full of default-named people reads as a
		// scenario written badly, not as one that failed to load.
		writeScenario({ ...artifact(), pack: "not-installed" });
		expect(loadScenario("drowned-archipelago")).toBeUndefined();
	});

	it("refuses a pack name that could walk out of the packs directory", () => {
		mkdirSync(scenarioRoot(), { recursive: true });
		writeFileSync(
			scenarioPath("sneaky"),
			JSON.stringify({ ...artifact(), id: "sneaky", pack: "../../etc/passwd" }),
		);
		expect(loadScenario("sneaky")).toBeUndefined();
	});

	it("still loads a scenario that carries its tables inline and names no pack", () => {
		writeScenario({ ...artifact(), content: { appearance: { cooper: "inline" } } });
		expect(loadScenario("drowned-archipelago")?.content?.appearance?.cooper).toBe("inline");
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
