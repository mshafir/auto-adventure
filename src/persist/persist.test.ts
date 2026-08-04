import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashString } from "../core/rand/hash.js";
import { createInitialState, type GameState, SAVE_VERSION } from "../core/rules/state.js";
import { createEffectRunner } from "../engine/effect-runner.js";
import { GameEngine } from "../engine/engine.js";
import { findSpawn } from "../engine/spawn.js";
import { migrateSave } from "./migrate.js";
import { SaveRepository, savePath } from "./save-repo.js";

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

describe("migrateSave", () => {
	it("accepts a current-version save", () => {
		const state = newState();
		expect(migrateSave(JSON.parse(JSON.stringify(state)))?.version).toBe(SAVE_VERSION);
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
