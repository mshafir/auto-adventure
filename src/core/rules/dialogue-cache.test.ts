import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import {
	CACHE_LIMIT,
	type CachedTurn,
	cachedTurn,
	turnKey,
	withCachedTurn,
} from "./dialogue-cache.js";
import { createInitialState, type GameState } from "./state.js";

/**
 * What the cache key is allowed to notice, and what it must not.
 *
 * The whole value of this file is in the negative assertions. A key that varied on one
 * thing too many would be a cache that never hits, which is indistinguishable from having
 * written none of this; a key that varied on one thing too few would serve a greeting from
 * before the story moved, which is worse than paying for a fresh one.
 */

const WORLD = {
	id: "t",
	name: "T",
	seed: hashString("dialogue-cache"),
	createdAt: "2026-01-01T00:00:00.000Z",
};

function state(overrides: Partial<GameState> = {}): GameState {
	return { ...createInitialState(WORLD, { x: 0, y: 0 }), ...overrides };
}

/** A conversation in which the player has said these things, in this order. */
function talking(said: readonly string[], flags: GameState["flags"] = {}): GameState {
	return state({
		flags,
		dialogue: {
			npcId: "npc:1",
			npcName: "Bram",
			lines: said.map((text) => ({ speaker: "You", text })),
			cursor: 0,
			choiceIndex: 0,
			pending: true,
		},
	});
}

const TURN: CachedTurn = {
	speech: "The ledger is gone.",
	choices: ["Who took it?"],
	actions: [],
	endsConversation: false,
	at: 0,
};

describe("what the key notices", () => {
	it("tells two people apart", () => {
		expect(turnKey(talking([]), "npc:1")).not.toBe(turnKey(talking([]), "npc:2"));
	});

	it("tells apart two points in the same conversation", () => {
		expect(turnKey(talking([]), "npc:1")).not.toBe(turnKey(talking(["Hello"]), "npc:1"));
		expect(turnKey(talking(["Hello"]), "npc:1")).not.toBe(
			turnKey(talking(["Hello", "And?"]), "npc:1"),
		);
	});

	it("tells apart the same question asked down two different branches", () => {
		// The case a player notices at once: the same words reached by a different route
		// are a different moment and should not share an answer.
		expect(turnKey(talking(["Threaten him", "Well?"]), "npc:1")).not.toBe(
			turnKey(talking(["Pay him", "Well?"]), "npc:1"),
		);
	});

	it("notices the story moving on", () => {
		// A written tree gates its nodes on flags. This is what gives the generated path
		// the same property: once a beat has opened, the cached greeting from before it
		// is no longer the answer to this moment.
		const before = turnKey(talking([]), "npc:1");
		const after = turnKey(talking([], { "arc:the-ledger": true }), "npc:1");
		expect(after).not.toBe(before);
	});

	it("does not notice the order flags were set in", () => {
		expect(turnKey(talking([], { a: true, b: true }), "npc:1")).toBe(
			turnKey(talking([], { b: true, a: true }), "npc:1"),
		);
	});

	it("does not notice a flag that is merely false", () => {
		// Otherwise every flag the engine has ever cleared would fragment the key.
		expect(turnKey(talking([], { seen: false }), "npc:1")).toBe(turnKey(talking([]), "npc:1"));
	});
});

describe("what the key deliberately ignores", () => {
	/**
	 * Everything here feeds the prompt and drifts constantly. Keying on any of it would
	 * make the key almost never repeat, which is a cache that costs memory and saves
	 * nothing. The price is that a revisit which changed no flags gets the reply it got
	 * last time — which is how an authored tree behaves, and is the point.
	 */
	it("ignores the clock, the weather's source, and where the player stands", () => {
		const base = talking(["Hello"]);
		const later: GameState = {
			...base,
			time: { ...base.time, tick: base.time.tick + 5000 },
			player: { ...base.player, x: 400, y: -90 },
		};
		expect(turnKey(later, "npc:1")).toBe(turnKey(base, "npc:1"));
	});

	it("ignores what the player is carrying", () => {
		const base = talking(["Hello"]);
		const rich: GameState = {
			...base,
			inventory: [{ name: "Gold", description: "Coins.", quantity: 90 }],
		};
		expect(turnKey(rich, "npc:1")).toBe(turnKey(base, "npc:1"));
	});
});

describe("storing and replaying", () => {
	it("returns what was stored, unchanged", () => {
		const key = turnKey(talking([]), "npc:1");
		const next = state({ dialogueCache: withCachedTurn(undefined, key, TURN) });
		expect(cachedTurn(next, key)).toEqual(TURN);
	});

	it("misses on a key that was never stored", () => {
		expect(cachedTurn(state(), "nothing")).toBeUndefined();
	});

	it("treats a save with no cache as a cold one", () => {
		// Which is every save made before this existed, and why no migration is needed.
		const old = state();
		expect(old.dialogueCache).toBeUndefined();
		expect(cachedTurn(old, turnKey(old, "npc:1"))).toBeUndefined();
	});

	it("keeps the newest and drops the oldest once it is full", () => {
		// Bounded for the reason the NPC summariser is bounded: a record that grows for
		// ever ends up the largest thing in the save.
		let cache: Record<string, CachedTurn> | undefined;
		for (let i = 0; i < CACHE_LIMIT + 10; i++) {
			cache = withCachedTurn(cache, `k${i}`, { ...TURN, at: i });
		}
		expect(Object.keys(cache ?? {})).toHaveLength(CACHE_LIMIT);
		// The ten oldest went, and nothing else did.
		expect(cache?.k0).toBeUndefined();
		expect(cache?.k9).toBeUndefined();
		expect(cache?.k10).toBeDefined();
		expect(cache?.[`k${CACHE_LIMIT + 9}`]).toBeDefined();
	});

	it("overwrites rather than growing when the same key is stored twice", () => {
		const first = withCachedTurn(undefined, "k", TURN);
		const second = withCachedTurn(first, "k", { ...TURN, speech: "Different." });
		expect(Object.keys(second)).toHaveLength(1);
		expect(second.k?.speech).toBe("Different.");
	});

	it("does not mutate the cache it was given", () => {
		const first = withCachedTurn(undefined, "k", TURN);
		withCachedTurn(first, "j", TURN);
		expect(Object.keys(first)).toEqual(["k"]);
	});
});
