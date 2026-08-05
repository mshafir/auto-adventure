import { describe, expect, it } from "vitest";
import {
	clockRuns,
	DEFAULT_START_HOUR,
	lightingRuns,
	schedulesRun,
	startTick,
	TICKS_PER_HOUR,
	type TimeOptions,
	timeFromTick,
	weatherRuns,
} from "./clock.js";
import { reduce, type WorldProbe } from "./reduce.js";
import { createInitialState, type GameState } from "./state.js";

function world(time?: TimeOptions) {
	return { id: "t", name: "t", seed: 1, createdAt: "", ...(time ? { time } : {}) };
}

const probe: WorldProbe = {
	isPassable: () => true,
	isLoaded: () => true,
	npcAt: () => undefined,
};

/** Walk `steps` tiles south, which is the facing a new player already has. */
function walk(state: GameState, steps: number): GameState {
	let current = state;
	for (let i = 0; i < steps; i++) {
		current = reduce(current, { t: "Move", facing: "down" }, probe).state;
	}
	return current;
}

describe("timeFromTick", () => {
	it("derives the calendar from the action counter", () => {
		expect(timeFromTick(0)).toEqual({ tick: 0, day: 1, hour: 0, minute: 0 });
		expect(timeFromTick(TICKS_PER_HOUR * 8 + 37)).toEqual({
			tick: TICKS_PER_HOUR * 8 + 37,
			day: 1,
			hour: 8,
			minute: 37,
		});
		expect(timeFromTick(TICKS_PER_HOUR * 24)).toMatchObject({ day: 2, hour: 0 });
	});

	it("honours a different hour length", () => {
		const time: TimeOptions = { ticksPerHour: 10 };
		expect(timeFromTick(25, time)).toMatchObject({ hour: 2, minute: 5 });
	});

	it("freezes the calendar while still counting actions", () => {
		// The tick is an action counter, not a clock: the journal orders on it and the
		// weather is sampled along it, so stopping it would break two things that have
		// nothing to do with the time of day.
		const time: TimeOptions = { enabled: false };
		expect(timeFromTick(0, time)).toEqual({ tick: 0, day: 1, hour: DEFAULT_START_HOUR, minute: 0 });
		expect(timeFromTick(9999, time)).toEqual({
			tick: 9999,
			day: 1,
			hour: DEFAULT_START_HOUR,
			minute: 0,
		});
	});

	it("freezes at the hour the author chose", () => {
		expect(timeFromTick(500, { enabled: false, startHour: 21 })).toMatchObject({ hour: 21 });
	});
});

describe("startTick", () => {
	it("opens a world in the morning by default", () => {
		expect(timeFromTick(startTick())).toMatchObject({ hour: DEFAULT_START_HOUR, minute: 0 });
	});

	it("scales with a custom hour length", () => {
		expect(startTick({ startHour: 3, ticksPerHour: 10 })).toBe(30);
	});
});

describe("the switches", () => {
	it("default to a running clock with everything on", () => {
		for (const time of [undefined, {} as TimeOptions]) {
			expect(clockRuns(time)).toBe(true);
			expect(lightingRuns(time)).toBe(true);
			expect(schedulesRun(time)).toBe(true);
			expect(weatherRuns(time)).toBe(true);
		}
	});

	it("turn lighting and schedules off with the clock", () => {
		const off: TimeOptions = { enabled: false };
		expect(clockRuns(off)).toBe(false);
		expect(lightingRuns(off)).toBe(false);
		expect(schedulesRun(off)).toBe(false);
	});

	it("keep weather on even with the clock off", () => {
		// Weather is sampled along the tick, which keeps counting, so a world with no
		// time of day can still have a sky. Turning that off is a separate decision.
		expect(weatherRuns({ enabled: false })).toBe(true);
		expect(weatherRuns({ enabled: false, weather: false })).toBe(false);
	});

	it("come apart individually", () => {
		// Lamplight without schedules, or schedules without a tinted sky.
		expect(lightingRuns({ enabled: false, lighting: true })).toBe(true);
		expect(schedulesRun({ enabled: false, lighting: true })).toBe(false);
		expect(lightingRuns({ schedules: false })).toBe(true);
		expect(schedulesRun({ schedules: false })).toBe(false);
	});
});

describe("a world with no clock, in play", () => {
	it("still counts the turns, so the journal keeps its order", () => {
		const state = createInitialState(world({ enabled: false }), { x: 0, y: 0 });
		const after = walk(state, 5);
		expect(after.time.tick).toBe(state.time.tick + 5);
	});

	it("never changes the hour, however long the game runs", () => {
		const state = createInitialState(world({ enabled: false, startHour: 14 }), { x: 0, y: 0 });
		const after = walk(state, TICKS_PER_HOUR * 30);
		expect(after.time.hour).toBe(14);
		expect(after.time.day).toBe(1);
		expect(after.time.minute).toBe(0);
	});

	it("opens on the frozen hour rather than on the default morning", () => {
		const state = createInitialState(world({ enabled: false, startHour: 23 }), { x: 0, y: 0 });
		expect(state.time.hour).toBe(23);
	});

	it("leaves a world with a clock exactly as it was", () => {
		const state = createInitialState(world(), { x: 0, y: 0 });
		expect(state.time.hour).toBe(DEFAULT_START_HOUR);
		const after = walk(state, TICKS_PER_HOUR);
		expect(after.time.hour).toBe(DEFAULT_START_HOUR + 1);
	});
});
