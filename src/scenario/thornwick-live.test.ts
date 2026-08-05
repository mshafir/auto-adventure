import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { arcOutline, beatEffects, branchKey, orderedBeats } from "../core/rules/arc.js";
import { pickEnding } from "../core/rules/ending.js";
import { barrierKey } from "../core/rules/lock.js";
import { questRows } from "../core/rules/quests.js";
import type { GameState } from "../core/rules/state.js";
import { npcId } from "../core/world/spec.js";
import { buildSession } from "../session.js";
import type { ScenarioArtifact } from "./artifact.js";
import { readScenarioFile, scenarioPath } from "./repo.js";
import { hasErrors, validateArtifact } from "./validate.js";

/**
 * The shipped scenario, in a running game.
 *
 * Everything below drives the real artifact through the real engine rather than a
 * fixture, because the whole point of this pass is that a *scenario* can now say these
 * things — and a fixture proving the mechanism works says nothing about whether the file
 * on disk uses it correctly. Each of the six features gets its own walk-through, taken
 * through the command alphabet the way a player would.
 */

let home: string;
let artifact: ScenarioArtifact;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-thornwick-"));
	process.env.AUTO_ADVENTURE_HOME = home;
	const read = readScenarioFile(scenarioPath("thornwick-road"));
	if (!read) throw new Error("the shipped scenario does not load");
	artifact = read;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

const HARROWMERE = 3139050156;
const BRACKEN = 2150566345;
const LEAD = "Lead Standard";

function start(worldId = "thornwick-live") {
	const session = buildSession(
		{ worldId, seed: 0, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0 },
	);
	// Read the framing card first, the way a player does. It blocks movement and
	// conversation on purpose, so skipping it would test a state nobody is ever in.
	session.engine.dispatch({ t: "DismissCard" });

	const state = () => session.engine.getState();

	/** Put the player somewhere, without walking there. */
	const goTo = (x: number, y: number) => {
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x, y }] });
	};

	/** Set a flag directly, to reach a point in the story without playing it out. */
	const set = (key: string, value: string | number | boolean = true) => {
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "SetFlag", key, value }] });
	};

	const talkTo = async (siteId: number, slot: number) => {
		const person = session.engine.personById(npcId(siteId, slot));
		if (!person) return undefined;
		session.engine.dispatch({ t: "DialogueOpened", npcId: person.id, npcName: person.name });
		await new Promise((resolve) => setTimeout(resolve, 0));
		return person;
	};

	return { session, state, goTo, set, talkTo };
}

describe("the shipped scenario", () => {
	it("validates with no errors", () => {
		// Run here as well as in the authoring tool, because this file is content and
		// content drifts: an edit that breaks a gate or strands an item should fail the
		// suite rather than waiting to be found by playing it.
		const findings = validateArtifact(artifact);
		const errors = findings.filter((finding) => finding.severity === "error");
		expect(errors.map((finding) => finding.message)).toEqual([]);
		expect(hasErrors(findings)).toBe(false);
	});

	it("carries its rules into the world", () => {
		const { session, state } = start();
		expect(state().triggers?.length).toBeGreaterThan(0);
		expect(state().barriers?.length).toBeGreaterThan(0);
		expect(state().placements?.length).toBeGreaterThan(0);
		session.dispose();
	});

	it("names the gated item somewhere the player will read it", () => {
		// The bug this pins down cost a real playthrough: the third act was gated on
		// carrying the Lead Standard and nothing in the game ever said the standard
		// existed, so the errand log went empty with nowhere to go. `checkFindability`
		// catches it now; this asserts the content stays fixed.
		const asked = (artifact.arc?.beats ?? []).flatMap((beat) =>
			(beat.quest?.objectives ?? []).filter((o) => o.kind === "have").map((o) => o.target),
		);
		expect(asked).toContain(LEAD);
	});

	it("picks up an edited story on resume, without losing progress", () => {
		// Otherwise fixing a scenario somebody is halfway through means telling them to
		// delete their save.
		const first = start("thornwick-resume");
		first.set("arc:the-short-tally");
		first.session.engine.dispatch({ t: "RequestSave" });
		first.session.dispose();

		const edited: ScenarioArtifact = {
			...artifact,
			arc: artifact.arc ? { ...artifact.arc, premise: "Edited between sessions." } : undefined,
		};
		const again = buildSession(
			{ worldId: "thornwick-resume", seed: 0, flavour: "prebuilt", scenario: edited },
			{ saveDebounceMs: 0 },
		);
		expect(again.engine.getState().arc?.premise).toBe("Edited between sessions.");
		// And the beat already opened is still open.
		expect(again.engine.getState().flags["arc:the-short-tally"]).toBe(true);
		again.dispose();
	});
});

describe("the gate on the Stonewait road", () => {
	/** One tile south of the gate, facing it. The pass runs north into Stonewait. */
	const APPROACH = { x: -103, y: -92 };
	const GATE = { x: -103, y: -93 };

	function atTheGate() {
		const started = start();
		started.goTo(APPROACH.x, APPROACH.y);
		// `Teleport` moves the player without building anything, so the chunks around the
		// gate have to be asked for explicitly — otherwise the step past it is refused for
		// being into ungenerated ground rather than by the gate.
		started.session.engine.getChunks().prefetch({ cx: -2, cy: -2 }, 2);
		// Face north, which the first press only turns to.
		started.session.engine.dispatch({ t: "Move", facing: "up" });
		return started;
	}

	it("refuses the road, and says why", () => {
		const { session, state } = atTheGate();
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().notice).toContain("barred");
		expect(state().player.y).toBe(APPROACH.y);
		session.dispose();
	});

	it("opens once the story has sent the player north", () => {
		const { session, state, set } = atTheGate();
		set("arc:the-short-tally");
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().flags[barrierKey("stonewait-gate")]).toBe(true);
		// Unbarring costs the turn; the step through comes next.
		expect(state().player.y).toBe(APPROACH.y);

		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().player.y).toBe(GATE.y);
		session.dispose();
	});

	it("stays open across a save and a reload", () => {
		// The one authored thing that writes into the map, so this is the one that had
		// to be persisted rather than derived.
		// The one authored thing that writes into the map, so this is the one that had
		// to be persisted rather than derived.
		const first = atTheGate();
		first.set("arc:the-short-tally");
		first.session.engine.dispatch({ t: "Move", facing: "up" });
		first.session.engine.dispatch({ t: "RequestSave" });
		first.session.dispose();

		const again = start();
		expect(again.state().flags[barrierKey("stonewait-gate")]).toBe(true);
		again.goTo(APPROACH.x, APPROACH.y);
		again.session.engine.getChunks().prefetch({ cx: -2, cy: -2 }, 2);
		// Two steps north, and no unbarring turn to pay this time — so the assertion is
		// that the gate is *behind* them rather than on an exact tile.
		again.session.engine.dispatch({ t: "Move", facing: "up" });
		again.session.engine.dispatch({ t: "Move", facing: "up" });
		expect(again.state().player.y).toBeLessThanOrEqual(GATE.y);
		again.session.dispose();
	});
});

describe("the Warden's Hall and the standard inside it", () => {
	/** Whichever tile the tower's door stands on, found the way the engine finds it. */
	function doorway(session: ReturnType<typeof start>["session"]) {
		const chunks = session.engine.getChunks();
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				for (const building of chunks.buildingsIn(-2 + dx, -2 + dy)) {
					if (building.lock) return building;
				}
			}
		}
		return undefined;
	}

	it("is locked until the warden has been spoken to", () => {
		const { session } = start();
		// Bring Stonewait's chunks in so its buildings are known.
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x: -106, y: -105 }] });
		session.engine.getChunks().prefetch({ cx: -2, cy: -2 }, 2);
		const tower = doorway(session);
		expect(tower, "the locked tower was not built").toBeDefined();
		if (!tower) return;

		// Stand on the doorstep and walk in.
		const step = { x: tower.door.x, y: tower.door.y + 1 };
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", ...step }] });
		session.engine.dispatch({ t: "Move", facing: "up" });
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(session.engine.getState().player.inside).toBeUndefined();
		expect(session.engine.getState().notice).toContain("shut");
		session.dispose();
	});

	it("holds the standard, and hands it over when searched", () => {
		const { session, state, set } = start();
		set("arc:the-second-weight");
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x: -106, y: -105 }] });
		session.engine.getChunks().prefetch({ cx: -2, cy: -2 }, 2);
		const tower = doorway(session);
		expect(tower, "the locked tower was not built").toBeDefined();
		if (!tower) return;

		// In through the now-unlocked door.
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: tower.door.x, y: tower.door.y + 1 }],
		});
		session.engine.dispatch({ t: "Move", facing: "up" });
		session.engine.dispatch({ t: "Move", facing: "up" });
		expect(state().player.inside?.interiorId).toBe(tower.interiorId);

		/*
		 * Search every tile of the room, from every side, the way a player works through
		 * one. Which container the standard ended up in is the generator's business, not
		 * the story's — the placement asked for "the tower" and the resolver picked a
		 * chest — so the test has to sweep rather than assert a tile.
		 *
		 * The teleport is repeated after the turn because `Move` does not only turn: it
		 * turns when the facing differs and *steps* when it already matches, so without
		 * putting the player back they drift off the tile being searched from.
		 */
		const view = session.engine.getView();
		const search = (x: number, y: number, facing: "up" | "down" | "left" | "right") => {
			// The tower has people in it, and walking into one opens a conversation — after
			// which every `Interact` advances the panel instead of searching anything. A
			// player would press ESC; so does this.
			session.engine.dispatch({ t: "CloseDialogue" });
			const put = { t: "ApplyEffects" as const, effects: [{ t: "Teleport" as const, x, y }] };
			session.engine.dispatch(put);
			session.engine.dispatch({ t: "Move", facing });
			session.engine.dispatch(put);
			session.engine.dispatch({ t: "Interact" });
		};
		for (let y = 0; y < 20; y++) {
			for (let x = 0; x < 20; x++) {
				if (!view.isPassable(x, y)) continue;
				for (const facing of ["up", "down", "left", "right"] as const) search(x, y, facing);
			}
		}
		expect(state().inventory.some((item) => item.name === LEAD)).toBe(true);
		session.dispose();
	});

	it("does not hold the standard before the story has got there", () => {
		// The placement is gated, so the same room searched early yields the ordinary
		// contents of an ordinary chest and nothing else.
		const { session, state } = start("thornwick-early");
		session.engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x: -106, y: -105 }] });
		session.engine.getChunks().prefetch({ cx: -2, cy: -2 }, 2);
		expect(session.engine.markedPlacements()).toEqual([]);
		expect(state().inventory.some((item) => item.name === LEAD)).toBe(false);
		session.dispose();
	});
});

describe("somebody the story brings on later", () => {
	it("is absent before the honest weight, and present after", async () => {
		const { session, state, goTo, set, talkTo } = start();
		goTo(-32, -168);
		session.engine.getChunks().prefetch({ cx: -1, cy: -3 }, 3);
		session.engine.populateNpcs({ cx: -1, cy: -3 });

		expect(session.engine.personById(npcId(HARROWMERE, 2))).toBeUndefined();
		expect(await talkTo(HARROWMERE, 2)).toBeUndefined();

		set("arc:the-honest-weight");
		const vance = session.engine.personById(npcId(HARROWMERE, 2));
		expect(vance?.name).toBe("Auditor Vance");
		expect(state().flags["arc:the-honest-weight"]).toBe(true);
		session.dispose();
	});
});

describe("the fork at Harrowmere", () => {
	/**
	 * The state a player is in when the choice is in front of them.
	 *
	 * Reached by applying the earlier beats' *effects* rather than by setting their
	 * flags, because a beat does two things — sets a flag and hands out an errand — and
	 * a test that only did the first would reach the fork with an empty quest log. The
	 * ending depends on those errands being closed, so faking half of a beat would make
	 * the ending unreachable for a reason no player would ever hit.
	 */
	function atTheFork() {
		const started = start();
		started.goTo(-32, -168);
		started.session.engine.getChunks().prefetch({ cx: -1, cy: -3 }, 3);

		const arc = started.state().arc;
		if (!arc) throw new Error("the shipped scenario has no arc");
		const before = orderedBeats(arc).filter(
			(beat) => beat.branch === undefined && !beat.optional && beat.order < 4,
		);
		for (const beat of before) {
			started.session.engine.dispatch({ t: "ApplyEffects", effects: beatEffects(beat) });
		}
		// The trigger that gates the fork watches for the standard in hand; granting it is
		// what the tower is for, and this stands in for having gone and got it.
		started.session.engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{ t: "GrantItem", name: LEAD, description: "Crown-stamped, and light.", quantity: 1 },
			],
		});
		// Beats raise cards, and a card blocks conversation on purpose. Read them all.
		while (started.state().card) started.session.engine.dispatch({ t: "DismissCard" });

		started.session.engine.populateNpcs({ cx: -1, cy: -3 });
		return started;
	}

	it("offers both arms until one is taken", async () => {
		const { session, state, talkTo } = atTheFork();
		expect(state().flags[branchKey("the-tally")]).toBeUndefined();
		// Vance is the reporting arm and is present, because the honest weight is done.
		expect(session.engine.personById(npcId(HARROWMERE, 2))).toBeDefined();
		expect(await talkTo(HARROWMERE, 0)).toBeDefined();
		session.dispose();
	});

	it("records the arm taken and bars the other for good", async () => {
		const { session, state, talkTo } = atTheFork();
		await talkTo(HARROWMERE, 0);
		expect(state().flags[branchKey("the-tally")]).toBe("bury-the-tally");
		expect(state().flags["arc:buried"]).toBe(true);

		// The other arm's anchor is still standing there and still talks, but the beat
		// behind them can never open again.
		session.engine.dispatch({ t: "CloseDialogue" });
		await talkTo(HARROWMERE, 2);
		expect(state().flags["arc:reported"]).toBeUndefined();
		session.dispose();
	});

	it("does not leave the story one step short of finished", async () => {
		// The arm not taken can never open, so counting it would stick `remaining` above
		// zero forever — the exact silent dead-end the outline exists to prevent.
		const { session, state, talkTo } = atTheFork();
		await talkTo(HARROWMERE, 0);
		const outline = arcOutline(state().arc, state());
		expect(outline?.remaining).toBe(0);
		session.dispose();
	});

	it("shows the card the chosen arm was written with", async () => {
		const { session, state, talkTo } = atTheFork();
		await talkTo(HARROWMERE, 0);
		const cards = [state().card, ...(state().pendingCards ?? [])].filter(Boolean);
		expect(cards.map((card) => card?.title)).toContain("The Drawer");
		session.dispose();
	});

	it("picks the outcome the choice earned", async () => {
		const { session, state, talkTo } = atTheFork();
		await talkTo(HARROWMERE, 0);
		const arc = state().arc;
		expect(arc).toBeDefined();
		if (!arc) return;
		expect(pickEnding(arc, state())?.id).toBe("the-quiet-pound");
		session.dispose();
	});

	it("closes the story on that outcome, once the errands are settled too", async () => {
		// Reaching the last beat is not the same as finishing: `arcOutline.finished` wants
		// every errand the story handed out closed as well, which is what stops the ending
		// firing while the player still has three things in the log.
		const { session, state, talkTo } = atTheFork();
		await talkTo(HARROWMERE, 0);
		session.engine.dispatch({ t: "CloseDialogue" });
		expect(state().quests.length).toBeGreaterThan(0);
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: state()
				.quests.filter((quest) => !quest.completed)
				.map((quest) => ({ t: "CompleteQuest" as const, id: quest.id })),
		});
		expect(state().flags["arc:complete"]).toBe(true);
		const seen = Object.keys(state().flags).filter((key) => key.startsWith("card:arc:end"));
		expect(seen).toContain("card:arc:end:the-quiet-pound");
		session.dispose();
	});
});

describe("the side errand", () => {
	it("does not hold the main story open", async () => {
		const { session, state, goTo, set, talkTo } = start();
		goTo(-104, 41);
		session.engine.getChunks().prefetch({ cx: -2, cy: 0 }, 3);
		set("arc:the-short-tally");
		session.engine.populateNpcs({ cx: -2, cy: 0 });

		await talkTo(BRACKEN, 1);
		const outline = arcOutline(state().arc, state());
		const aside = outline?.steps.find((step) => step.label.includes("Kilnwait"));
		if (aside) expect(aside.optional).toBe(true);
		session.dispose();
	});
});

describe("the errand tree", () => {
	it("shows the two weights as steps of the Crown Yard", () => {
		const { session, state } = start();
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "CreateQuest",
					id: "the-crown-yard",
					name: "The Crown Yard",
					description: "",
					objectives: [{ kind: "quest", target: "the-second-weight", done: false }],
				},
				{
					t: "CreateQuest",
					id: "the-second-weight",
					name: "The Second Weight",
					description: "",
					objectives: [],
					parentId: "the-crown-yard",
				},
			],
		});
		const rows = questRows(state() as GameState);
		expect(rows.map((row) => [row.quest.id, row.depth])).toEqual([
			["the-crown-yard", 0],
			["the-second-weight", 1],
		]);
		session.dispose();
	});
});
