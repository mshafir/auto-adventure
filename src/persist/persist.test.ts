import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashString } from "../core/rand/hash.js";
import { createInitialState, type GameState, SAVE_VERSION } from "../core/rules/state.js";
import { createEffectRunner } from "../engine/effect-runner.js";
import { GameEngine } from "../engine/engine.js";
import { findSpawn } from "../engine/spawn.js";
import { migrateSave } from "./migrate.js";
import { deleteSave, listSaves, SaveRepository, savePath } from "./save-repo.js";

const SEED = hashString("persist-test");
let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-test-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	// Assigning undefined would set the literal string "undefined".
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

function newState(id = "test"): GameState {
	return createInitialState(
		{ id, name: id, seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
		findSpawn(SEED),
	);
}

describe("SaveRepository", () => {
	it("writes and reads a round trip", () => {
		const repo = new SaveRepository(0);
		const state = newState();
		repo.schedule(state);
		repo.flush();

		const loaded = new SaveRepository(0).load("test");
		expect(loaded?.player).toEqual(state.player);
		expect(loaded?.world.seed).toBe(SEED);
	});

	it("coalesces repeated schedules into one write", () => {
		const repo = new SaveRepository(0);
		for (let i = 0; i < 50; i++) repo.schedule(newState());
		repo.flush();
		// A second flush with nothing pending must be a no-op, not a rewrite.
		repo.flush();
		expect(readFileSync(savePath("test"), "utf8").length).toBeGreaterThan(0);
	});

	it("returns undefined for a world that was never saved", () => {
		expect(new SaveRepository(0).load("nonexistent")).toBeUndefined();
	});

	it("survives a corrupt save rather than crashing the game", () => {
		const path = savePath("broken");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ this is not json");
		expect(new SaveRepository(0).load("broken")).toBeUndefined();
	});

	it("leaves no temporary file behind", () => {
		const repo = new SaveRepository(0);
		repo.schedule(newState());
		repo.flush();
		expect(() => readFileSync(`${savePath("test")}.tmp`)).toThrow();
	});
});

describe("listing and deleting worlds", () => {
	function write(id: string) {
		const repo = new SaveRepository(0);
		repo.schedule(newState(id));
		repo.flush();
	}

	it("surfaces when a world was made, which is how two get told apart", () => {
		write("hollowmoor");
		const listed = listSaves();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(listed[0]?.playedAt).toBeGreaterThan(0);
	});

	it("takes a world off the list, and its directory with it", () => {
		write("hollowmoor");
		write("thornwick");
		expect(deleteSave("hollowmoor")).toBe(true);
		expect(listSaves().map((save) => save.worldId)).toEqual(["thornwick"]);
		expect(existsSync(dirname(savePath("hollowmoor")))).toBe(false);
	});

	/*
	 * The whole directory rather than just `save.json`. A leftover folder makes the
	 * world invisible in the launcher while still holding its name, so a new world
	 * called the same thing would be uniquified to `hollowmoor-2` for no reason the
	 * player could see.
	 */
	it("leaves nothing behind that would still hold the name", () => {
		write("hollowmoor");
		writeFileSync(join(dirname(savePath("hollowmoor")), "stray.txt"), "x");
		deleteSave("hollowmoor");
		expect(existsSync(dirname(savePath("hollowmoor")))).toBe(false);
	});

	it("says so rather than throwing when there is nothing to delete", () => {
		expect(deleteSave("never-existed")).toBe(false);
	});

	/*
	 * A recursive delete under the player's home directory. The id reaching this
	 * comes from a save the launcher listed, so it is already trustworthy — but a
	 * path separator arriving from anywhere else must not be able to walk out of the
	 * saves folder, because there is no undo.
	 */
	it("refuses a name that could walk out of the saves directory", () => {
		write("hollowmoor");
		for (const bad of ["../saves", "a/b", "..", "", "a\\b"]) {
			expect(deleteSave(bad), bad).toBe(false);
		}
		expect(listSaves()).toHaveLength(1);
	});
});

describe("migrateSave", () => {
	it("accepts a current-version save", () => {
		const state = newState();
		expect(migrateSave(JSON.parse(JSON.stringify(state)))?.version).toBe(SAVE_VERSION);
	});

	it("carries a brief across a round trip", () => {
		// A resumed world has to keep generating in the same key. Losing the brief
		// here would name the regions found after a reload from the default premise.
		const state = { ...newState(), brief: { premise: "a drowned archipelago" } } as GameState;
		expect(migrateSave(JSON.parse(JSON.stringify(state)))?.brief).toEqual({
			premise: "a drowned archipelago",
		});
	});

	it("loads a save that predates briefs", () => {
		const state = newState();
		expect(state.brief).toBeUndefined();
		expect(migrateSave(JSON.parse(JSON.stringify(state)))?.brief).toBeUndefined();
	});

	it("discards a hand-edited brief that says nothing", () => {
		const state = { ...newState(), brief: { premise: "  ", tone: "" } } as GameState;
		expect(migrateSave(JSON.parse(JSON.stringify(state)))?.brief).toBeUndefined();
	});

	it("retires pre-rewrite saves instead of mangling them", () => {
		// The old format was an LLM-drawn string map per world coordinate with no
		// seed; there is no honest way to reconstruct a procedural world from it.
		const legacy = { locked: false, map: { mapTiles: "ggg\nggg" }, playerPosition: [1, 1] };
		expect(migrateSave(legacy)).toBeUndefined();
	});

	it("refuses a save from a newer build", () => {
		expect(migrateSave({ ...newState(), version: 999 })).toBeUndefined();
	});

	it("rejects a structurally invalid save", () => {
		expect(migrateSave({ version: SAVE_VERSION, player: {}, world: {} })).toBeUndefined();
		expect(migrateSave(null)).toBeUndefined();
		expect(migrateSave("nope")).toBeUndefined();
	});

	it("never restores a dialogue that was open when the game was saved", () => {
		// UI-transient state must not come back from disk. Persisting it is how
		// the old design could reload into a permanently wedged game.
		const withDialogue = {
			...newState(),
			dialogue: { npcId: "n", npcName: "N", lines: [], cursor: 0, choiceIndex: 0, pending: true },
		};
		const restored = migrateSave(JSON.parse(JSON.stringify(withDialogue)));
		expect(restored?.dialogue).toBeUndefined();
	});

	it("fills in fields a partial save is missing", () => {
		const partial = { ...newState() } as Record<string, unknown>;
		partial.discovered = undefined;
		partial.flags = undefined;
		const restored = migrateSave(JSON.parse(JSON.stringify(partial)));
		expect(restored?.discovered).toEqual([]);
		expect(restored?.flags).toEqual({});
	});
});

describe("engine persistence", () => {
	it("saves after the player walks and reloads to the same spot", () => {
		const repo = new SaveRepository(0);
		const engine = new GameEngine(newState("walker"), createEffectRunner({ saves: repo }));

		// Face, then walk; the first press of a new direction only turns.
		for (let i = 0; i < 12; i++) engine.dispatch({ t: "Move", facing: "right" });
		for (let i = 0; i < 8; i++) engine.dispatch({ t: "Move", facing: "down" });
		repo.flush();

		const moved = engine.getState();
		const reloaded = new SaveRepository(0).load("walker");
		expect(reloaded).toBeDefined();
		expect(reloaded?.player.x).toBe(moved.player.x);
		expect(reloaded?.player.y).toBe(moved.player.y);
		expect(reloaded?.time.tick).toBe(moved.time.tick);
	});

	it("keeps a heavily explored world small by never saving tile arrays", () => {
		const repo = new SaveRepository(0);
		const engine = new GameEngine(newState("explorer"), createEffectRunner({ saves: repo }));
		// Walk far enough to touch several chunks.
		for (let i = 0; i < 200; i++) engine.dispatch({ t: "Move", facing: "right" });
		for (let i = 0; i < 200; i++) engine.dispatch({ t: "Move", facing: "down" });
		repo.flush();

		const bytes = readFileSync(savePath("explorer"), "utf8").length;
		// Four hundred steps of terrain is megabytes if tiles are persisted;
		// storing only the seed and the deltas keeps it tiny.
		expect(bytes).toBeLessThan(20_000);
	});

	it("restores into a running engine without regenerating under the player", () => {
		const repo = new SaveRepository(0);
		const engine = new GameEngine(newState("resume"), createEffectRunner({ saves: repo }));
		for (let i = 0; i < 10; i++) engine.dispatch({ t: "Move", facing: "right" });
		repo.flush();

		const saved = new SaveRepository(0).load("resume");
		expect(saved).toBeDefined();
		const resumed = new GameEngine(saved as GameState, createEffectRunner({ saves: repo }));
		expect(resumed.getState().player).toEqual(engine.getState().player);
		// And the ground under the resumed player is still standable.
		expect(
			resumed.getView().isPassable(resumed.getState().player.x, resumed.getState().player.y),
		).toBe(true);
	});
});

describe("the clock survives a reload", () => {
	it("recomputes day, hour and minute from the tick", () => {
		// A save written before `minute` existed has no minute in it, and every field
		// is derivable from the tick — so recomputing is both the backfill and a
		// repair for any save whose fields disagree with their own tick.
		const stored = { ...newState(), time: { tick: 9 * 60 + 37, day: 99, hour: 99 } };
		const restored = migrateSave(JSON.parse(JSON.stringify(stored)));
		expect(restored?.time).toEqual({ tick: 9 * 60 + 37, day: 1, hour: 9, minute: 37 });
	});
});

describe("saving on the way out", () => {
	it("writes immediately rather than leaving it to the debounce", () => {
		/**
		 * The debounce timer is deliberately `unref`'d so a pending save cannot hold
		 * the process open — which also means a quitting process abandons it. The
		 * key bar promises "S save+quit", so the command behind it has to flush.
		 */
		const repo = new SaveRepository(60_000);
		const engine = new GameEngine(newState("quitter"), createEffectRunner({ saves: repo }));
		for (let i = 0; i < 6; i++) engine.dispatch({ t: "Move", facing: "right" });

		// Nothing on disk yet: every step only scheduled a debounced write.
		expect(new SaveRepository(0).load("quitter")).toBeUndefined();

		engine.dispatch({ t: "RequestSave" });

		const saved = new SaveRepository(0).load("quitter");
		expect(saved?.player.x).toBe(engine.getState().player.x);
		expect(saved?.time.tick).toBe(engine.getState().time.tick);
	});

	it("keeps what was dropped dropped", () => {
		const repo = new SaveRepository(0);
		const engine = new GameEngine(newState("dropper"), createEffectRunner({ saves: repo }));
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "GrantItem", name: "Timber", description: "Planks.", quantity: 3 }],
		});
		engine.dispatch({ t: "DropItem", name: "Timber", quantity: 3 });
		repo.flush();

		const saved = new SaveRepository(0).load("dropper");
		expect(saved?.inventory.some((item) => item.name === "Timber")).toBe(false);
	});
});
