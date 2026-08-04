import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashString } from "./core/rand/hash.js";
import type { ScenarioBrief } from "./core/world/brief.js";
import type { LaunchChoice } from "./scenario/scenario.js";
import { buildSession, MissingSaveError, resolveBrief } from "./session.js";

const SEED = hashString("session-test");
let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-session-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	// Assigning undefined would set the literal string "undefined".
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

function choice(overrides: Partial<LaunchChoice> = {}): LaunchChoice {
	return { worldId: "test", seed: SEED, flavour: "procedural", ...overrides };
}

/**
 * Play one action so the debounced save actually lands on disk.
 *
 * Two moves, not one: the first press of a new direction only turns, so a single
 * dispatch would leave the player standing where they started.
 */
function saveNow(session: ReturnType<typeof buildSession>) {
	session.engine.dispatch({ t: "Move", facing: "down" });
	session.engine.dispatch({ t: "Move", facing: "down" });
	session.saves.schedule(session.engine.getState());
	session.saves.flush();
}

describe("resolveBrief", () => {
	const saved: ScenarioBrief = { premise: "a drowned archipelago" };
	const offered: ScenarioBrief = { premise: "a desert of glass towers" };

	it("keeps the brief a world already has", () => {
		expect(resolveBrief(saved, offered)).toEqual({ brief: saved, ignored: true });
	});

	it("adopts an offered brief when the world has none", () => {
		expect(resolveBrief(undefined, offered)).toEqual({ brief: offered, ignored: false });
	});

	it("does not report an offer that was never made as ignored", () => {
		// The bug this pins: a new world's brief *is* the offered one, so reporting
		// on the resolved value rather than the saved one warned that every briefed
		// new world was ignoring its own brief.
		expect(resolveBrief(saved, undefined)).toEqual({ brief: saved, ignored: false });
		expect(resolveBrief(undefined, undefined)).toEqual({ brief: undefined, ignored: false });
	});
});

describe("buildSession", () => {
	it("creates a world when the slot is empty", () => {
		const session = buildSession(choice(), { saveDebounceMs: 0 });
		expect(session.state.world.seed).toBe(SEED);
		expect(session.state.world.id).toBe("test");
		session.dispose();
	});

	it("resumes a world instead of regenerating it", () => {
		const first = buildSession(choice(), { saveDebounceMs: 0 });
		saveNow(first);
		const moved = first.engine.getState().player;
		first.dispose();

		// A different seed must not move the player or rebuild the terrain: the save
		// carries its own seed and wins.
		const second = buildSession(choice({ seed: hashString("something-else") }), {
			saveDebounceMs: 0,
		});
		expect(second.state.world.seed).toBe(SEED);
		expect(second.state.player.x).toBe(moved.x);
		expect(second.state.player.y).toBe(moved.y);
		second.dispose();
	});

	it("refuses to invent a world the launcher expected to find", () => {
		expect(() => buildSession(choice({ worldId: "ghost", mustExist: true }))).toThrow(
			MissingSaveError,
		);
	});

	it("persists an offered brief into a new world", () => {
		const brief: ScenarioBrief = { premise: "a drowned archipelago" };
		const session = buildSession(choice({ brief }), { saveDebounceMs: 0 });
		expect(session.state.brief).toEqual(brief);
		saveNow(session);
		session.dispose();

		const resumed = buildSession(choice(), { saveDebounceMs: 0 });
		expect(resumed.state.brief).toEqual(brief);
		resumed.dispose();
	});

	it("lets an unbriefed world adopt a brief without being restarted", () => {
		const first = buildSession(choice(), { saveDebounceMs: 0 });
		expect(first.state.brief).toBeUndefined();
		saveNow(first);
		first.dispose();

		const brief: ScenarioBrief = { premise: "a desert of glass towers" };
		const second = buildSession(choice({ brief }), { saveDebounceMs: 0 });
		expect(second.state.brief).toEqual(brief);
		saveNow(second);
		second.dispose();

		const third = buildSession(choice(), { saveDebounceMs: 0 });
		expect(third.state.brief).toEqual(brief);
		third.dispose();
	});

	it("will not re-brief a world that already has one", () => {
		const original: ScenarioBrief = { premise: "a drowned archipelago" };
		const first = buildSession(choice({ brief: original }), { saveDebounceMs: 0 });
		saveNow(first);
		first.dispose();

		const second = buildSession(choice({ brief: { premise: "a desert of glass towers" } }), {
			saveDebounceMs: 0,
		});
		expect(second.state.brief).toEqual(original);
		second.dispose();
	});

	it("is idempotent on dispose", () => {
		const session = buildSession(choice(), { saveDebounceMs: 0 });
		session.dispose();
		expect(() => session.dispose()).not.toThrow();
	});
});
