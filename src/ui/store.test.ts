import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../core/rules/state.js";
import type { GameEngine } from "../engine/engine.js";
import { bindEngine, subscribeToState } from "./store.js";

/**
 * A stand-in for the engine, and for React.
 *
 * Neither is what is under test. What is, is the scheduling between them, and
 * scheduling is only observable through who gets called and when.
 */
function fakeEngine() {
	let tick = 0;
	const listeners = new Set<() => void>();
	return {
		engine: {
			getState: () => ({ tick }) as unknown as GameState,
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		} as unknown as GameEngine,
		/** One state change, as a dispatch produces. */
		change: () => {
			tick += 1;
			for (const listener of listeners) listener();
		},
	};
}

/** A mounted component, as far as the store can tell. */
function watch() {
	const record = { frames: 0 };
	const stop = subscribeToState(() => {
		record.frames += 1;
	});
	return { record, stop };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("with coalescing off", () => {
	it("renders on every change", () => {
		// The default, and it has to be: a test that dispatches and then reads the
		// frame would otherwise read the frame from before the dispatch, and the
		// screenshot tool would capture a page it had already left.
		const { engine, change } = fakeEngine();
		bindEngine(engine);
		const { record, stop } = watch();
		change();
		change();
		change();
		expect(record.frames).toBe(3);
		stop();
	});
});

describe("with coalescing on", () => {
	it("draws the first change immediately", () => {
		// A single keypress must never wait. Only a burst is worth collapsing, and a
		// burst is by definition not the first of anything.
		vi.useFakeTimers();
		const { engine, change } = fakeEngine();
		bindEngine(engine, { frameMs: 33 });
		const { record, stop } = watch();
		change();
		expect(record.frames).toBe(1);
		stop();
	});

	it("collapses a burst into one frame", () => {
		/*
		 * A frame costs about 20ms to composite, rasterise and compress, and a
		 * terminal's key repeat is faster than that. A render per keystroke — each one
		 * starting inside the stdin handler that delivered the key — is what made the
		 * display fall behind the player's fingers and keep moving after they let go.
		 */
		vi.useFakeTimers();
		const { engine, change } = fakeEngine();
		bindEngine(engine, { frameMs: 33 });
		const { record, stop } = watch();

		change();
		for (let i = 0; i < 10; i++) change();
		expect(record.frames).toBe(1);

		vi.advanceTimersByTime(33);
		expect(record.frames).toBe(2);
		stop();
	});

	it("draws the state as it is when the frame runs, not as it was when asked", () => {
		// Which is why collapsing loses nothing: the eleven changes above are not
		// eleven pictures the player missed, they are one picture drawn once.
		vi.useFakeTimers();
		const { engine, change } = fakeEngine();
		bindEngine(engine, { frameMs: 33 });
		const seen: number[] = [];
		const stop = subscribeToState(() => {
			seen.push((engine.getState() as unknown as { tick: number }).tick);
		});
		change();
		for (let i = 0; i < 10; i++) change();
		vi.advanceTimersByTime(33);
		expect(seen).toEqual([1, 11]);
		stop();
	});

	it("keeps exactly one timer outstanding however many changes arrive", () => {
		// A timer per change would be a queue of frames, each drawing what the one
		// before it already drew.
		vi.useFakeTimers();
		const { engine, change } = fakeEngine();
		bindEngine(engine, { frameMs: 33 });
		const { stop } = watch();
		change();
		for (let i = 0; i < 50; i++) change();
		expect(vi.getTimerCount()).toBe(1);
		stop();
	});

	it("settles once the burst stops", () => {
		vi.useFakeTimers();
		const { engine, change } = fakeEngine();
		bindEngine(engine, { frameMs: 33 });
		const { record, stop } = watch();
		change();
		change();
		vi.advanceTimersByTime(10_000);
		expect(record.frames).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
		stop();
	});
});

describe("the subscription itself", () => {
	it("follows a rebind onto the new engine", () => {
		// The launcher can open a second world into the same tree, and a frame drawn
		// from the world the player has just left is worse than no frame at all.
		const first = fakeEngine();
		const second = fakeEngine();
		bindEngine(first.engine);
		const { record, stop } = watch();
		bindEngine(second.engine);
		first.change();
		expect(record.frames).toBe(0);
		second.change();
		expect(record.frames).toBe(1);
		stop();
	});

	it("lets go of the engine when the last listener does", () => {
		const { engine, change } = fakeEngine();
		bindEngine(engine);
		const first = watch();
		const second = watch();
		first.stop();
		change();
		expect(second.record.frames).toBe(1);
		second.stop();
		change();
		expect(second.record.frames).toBe(1);
	});

	it("drops a pending frame when the last listener goes away", () => {
		// Otherwise a timer set during teardown fires into an unmounted tree.
		vi.useFakeTimers();
		const { engine, change } = fakeEngine();
		bindEngine(engine, { frameMs: 33 });
		const { stop } = watch();
		change();
		change();
		expect(vi.getTimerCount()).toBe(1);
		stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
