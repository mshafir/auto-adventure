import { describe, expect, it } from "vitest";
import { getComplex } from "../core/gen/features/interior.js";
import type { StructureKind } from "../core/gen/features/patch.js";
import { hashString } from "../core/rand/hash.js";
import { createInitialState } from "../core/rules/state.js";
import { T } from "../core/tiles/terrain.js";
import { GameEngine } from "./engine.js";

/**
 * Climbing and descending, driven the way a player drives it.
 *
 * The generator's own tests prove the stairs line up. These prove the *engine* agrees
 * with them: that walking onto a stair tile moves the player to the matching tile on
 * the right level, that the way out stays where it was however deep they went, and
 * that arriving on a stair does not immediately send them back.
 */

const SEED = hashString("levels-test");

/** A player standing inside an interior, on the ground floor. */
function inside(kind: StructureKind, interiorId = 1234) {
	const levels = getComplex(SEED, interiorId, kind);
	const base = createInitialState(
		{ id: "t", name: "t", seed: SEED, createdAt: "" },
		{ x: 0, y: 0 },
	);
	const ground = levels[0] as (typeof levels)[number];
	const engine = new GameEngine(
		{
			...base,
			player: {
				...base.player,
				x: ground.entrance.x,
				y: ground.entrance.y,
				inside: {
					interiorId,
					structure: kind,
					returnX: 500,
					returnY: 600,
				},
			},
		},
		{ runEffect: () => undefined },
	);
	return { engine, levels };
}

/**
 * Stand one tile below the target and walk onto it.
 *
 * A portal fires on *walking onto* a tile and nothing else, which is the property
 * under test — so the player is put beside it and then made to take a real step. The
 * first `Move` may only turn (turning is free and does not advance the turn), which is
 * why there are two.
 */
function stepOnto(engine: GameEngine, to: { x: number; y: number }) {
	engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x: to.x, y: to.y + 1 }] });
	engine.dispatch({ t: "Move", facing: "up" });
	if (engine.getState().player.y === to.y + 1) engine.dispatch({ t: "Move", facing: "up" });
}

describe("people on an upper floor", () => {
	it("can be walked into and spoken to, like anybody downstairs", () => {
		/*
		 * Two code paths asked "who is standing here" and only one of them knew about
		 * storeys. The renderer used `personAt`, which took the level; the reducer's probe
		 * had an early return above the ground floor left over from when residents were
		 * ground-floor-only. So the upper rooms of a keep were drawn full of people the
		 * player walked straight through and could not talk to.
		 */
		const { engine, levels } = inside("tower", 9876);
		const upper = levels[1];
		expect(upper, "the tower has no upper floor").toBeDefined();
		if (!upper) return;

		const people = engine.getResidents().in(9876, "tower", 1);
		expect(people.length, "nobody lives upstairs in this tower").toBeGreaterThan(0);
		const person = people[0] as (typeof people)[number];

		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: person.x, y: person.y + 1 }],
		});
		// Put the player on the storey the person is on.
		const state = engine.getState();
		engine.hydrate({
			...state,
			player: {
				...state.player,
				inside: { ...(state.player.inside as NonNullable<typeof state.player.inside>), level: 1 },
			},
		});

		expect(engine.personAt(person.x, person.y)?.name).toBe(person.name);
		engine.dispatch({ t: "Move", facing: "up" });
		engine.dispatch({ t: "Move", facing: "up" });
		// Walking into somebody opens a conversation rather than moving.
		expect(engine.getState().dialogue?.npcName).toBe(person.name);
		expect(engine.getState().player.y).toBe(person.y + 1);
	});
});

describe("climbing a tower", () => {
	it("goes up, and the stairs come out where the generator put them", () => {
		const { engine, levels } = inside("tower");
		const up = (levels[0] as (typeof levels)[number]).portals.find((p) => p.to === 1);
		expect(up).toBeDefined();

		stepOnto(engine, up as { x: number; y: number });
		const now = engine.getState().player;
		expect(now.inside?.level).toBe(1);

		const back = (levels[1] as (typeof levels)[number]).portals.find((p) => p.to === 0);
		expect({ x: now.x, y: now.y }).toEqual({ x: back?.x, y: back?.y });
	});

	it("does not bounce straight back off the stair it arrived on", () => {
		// Arriving puts the player *on* the down stair. A portal fires on walking onto a
		// tile, so standing on one has to be inert — otherwise a staircase is a loop.
		const { engine, levels } = inside("tower");
		const up = (levels[0] as (typeof levels)[number]).portals.find((p) => p.to === 1);
		stepOnto(engine, up as { x: number; y: number });
		expect(engine.getState().player.inside?.level).toBe(1);
		engine.dispatch({ t: "Tick", amount: 1 });
		expect(engine.getState().player.inside?.level).toBe(1);
	});

	it("comes back down to the tile it left from", () => {
		const { engine, levels } = inside("tower");
		const up = (levels[0] as (typeof levels)[number]).portals.find((p) => p.to === 1);
		stepOnto(engine, up as { x: number; y: number });

		const down = (levels[1] as (typeof levels)[number]).portals.find((p) => p.to === 0);
		stepOnto(engine, down as { x: number; y: number });
		const now = engine.getState().player;
		expect(now.inside?.level ?? 0).toBe(0);
		expect({ x: now.x, y: now.y }).toEqual({ x: up?.x, y: up?.y });
	});

	it("keeps the doorstep it came in by, however high it climbs", () => {
		// The reason changing level is not "leave then enter": the player never returns
		// to the world in between, so the tile outside the front door has to survive.
		const { engine, levels } = inside("tower");
		for (const target of [1, 2]) {
			const level = engine.getState().player.inside?.level ?? 0;
			const portal = (levels[level] as (typeof levels)[number]).portals.find(
				(p) => p.to === target,
			);
			stepOnto(engine, portal as { x: number; y: number });
		}
		const now = engine.getState().player;
		expect(now.inside?.level).toBe(2);
		expect(now.inside?.returnX).toBe(500);
		expect(now.inside?.returnY).toBe(600);
	});

	it("shows the storey the player is on, not the ground floor", () => {
		const { engine, levels } = inside("tower");
		const up = (levels[0] as (typeof levels)[number]).portals.find((p) => p.to === 1);
		stepOnto(engine, up as { x: number; y: number });

		const view = engine.getView();
		const arrived = engine.getState().player;
		// Standing on a down stair is the giveaway: the ground floor has none.
		expect(view.terrainAt(arrived.x, arrived.y)).toBe(T.stairsDown);
	});
});

describe("going down into a cave", () => {
	it("descends, and the way out stays on the surface level", () => {
		const { engine, levels } = inside("cave", 88);
		expect(levels.length).toBeGreaterThan(1);
		const down = (levels[0] as (typeof levels)[number]).portals.find((p) => p.to === 1);
		expect(down).toBeDefined();

		stepOnto(engine, down as { x: number; y: number });
		expect(engine.getState().player.inside?.level).toBe(1);

		// The mouth is on level 0 and nowhere else, so a player two levels down cannot
		// walk out of a wall.
		const here = levels[1] as (typeof levels)[number];
		expect([...here.terrain]).not.toContain(T.doorOpen);
	});
});
