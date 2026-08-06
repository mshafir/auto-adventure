import { useSyncExternalStore } from "react";
import type { GameState } from "../core/rules/state.js";
import type { GameEngine } from "../engine/engine.js";

/**
 * The React binding to engine state.
 *
 * There is intentionally no `setState` here and no store object to reach for:
 * the engine owns the state and this is a read-only projection of it. A biome
 * rule bans importing `zustand` anywhere else in the tree, so the seventeen
 * scattered store writes the previous design accumulated cannot come back by
 * accident — they would fail lint before they failed review.
 */
let engineRef: GameEngine | undefined;

/**
 * The shortest gap between two frames, in milliseconds. Zero renders on every
 * change, which is what tests and tools want.
 *
 * A frame costs about 20ms to composite, rasterise and compress — measured with
 * `npm run pixel-bench` at the sizes the game actually draws. A terminal's key
 * repeat is faster than that. So holding a direction key used to queue a render
 * per keystroke, each one starting inside the stdin handler that delivered the
 * key: the display fell steadily behind the player's fingers, and when they let go
 * it kept going for as long as it took to work through the backlog. That is the
 * "overshoot", and the character was never in the wrong place — the picture of
 * them was simply out of date.
 *
 * Rendering on a timer instead decouples the two. Every keystroke still reaches
 * the engine immediately and in order; what is dropped is the *intermediate
 * pictures*, which nobody could have seen anyway. The player walks three tiles in
 * the time one frame takes, and the frame that goes out shows them three tiles
 * along, rather than the first of three going out late.
 */
let frameMs = 0;

const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** When the next frame may *start*, not when the last one finished. */
let nextFrameAt = 0;

export interface BindOptions {
	/**
	 * Coalesce changes arriving closer together than this into one render.
	 *
	 * Off by default, and it has to be: a test that dispatches and then reads the
	 * frame would otherwise be reading the frame from before the dispatch, and a
	 * screenshot tool would capture the title of a page it had already left.
	 */
	readonly frameMs?: number;
}

export function bindEngine(engine: GameEngine, options: BindOptions = {}): void {
	unsubscribe?.();
	unsubscribe = undefined;
	if (timer !== undefined) clearTimeout(timer);
	timer = undefined;
	nextFrameAt = 0;

	engineRef = engine;
	frameMs = options.frameMs ?? 0;
	// A component may already be mounted across a rebind — the launcher opening a
	// second world into the same tree — so the subscription follows the engine.
	if (listeners.size > 0) unsubscribe = engine.subscribe(onChange);
}

export function getEngine(): GameEngine {
	if (!engineRef) throw new Error("engine not bound; call bindEngine() before rendering");
	return engineRef;
}

/**
 * Present a frame, and work out when the next one may start.
 *
 * The budget is `max(frameMs, what the last frame cost)`. The floor is the frame
 * rate asked for; the other half is what stops a machine slower than the budget
 * from spending every millisecond it has on rendering and never reading the
 * keyboard — on such a machine `frameMs` is already met and only the measured
 * cost says anything useful.
 */
function present(): void {
	const started = performance.now();
	// A copy, because a listener unsubscribing mid-notification is ordinary React
	// teardown and must not skip the listener after it.
	for (const listener of [...listeners]) listener();
	nextFrameAt = started + Math.max(frameMs, performance.now() - started);
}

function onChange(): void {
	if (frameMs <= 0) {
		present();
		return;
	}
	const wait = nextFrameAt - performance.now();
	if (wait <= 0) {
		present();
		return;
	}
	// One outstanding timer, never a queue of them: every change between now and
	// then is already covered by the frame it will draw, because the frame reads
	// whatever the state is when it runs rather than what it was when it was asked
	// for.
	if (timer !== undefined) return;
	timer = setTimeout(() => {
		timer = undefined;
		present();
	}, wait);
	// Nothing left undrawn matters once the process is going away, and an
	// outstanding frame must not be the reason it stays.
	timer.unref?.();
}

/**
 * What both hooks hand to `useSyncExternalStore`.
 *
 * Exported because it is the thing worth testing here — everything above is
 * scheduling, and scheduling is only observable through who gets called and when.
 */
export function subscribeToState(listener: () => void): () => void {
	listeners.add(listener);
	if (!unsubscribe) unsubscribe = getEngine().subscribe(onChange);
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		unsubscribe?.();
		unsubscribe = undefined;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
}

export function useGameState(): GameState {
	const engine = getEngine();
	return useSyncExternalStore(subscribeToState, engine.getState, engine.getState);
}

/**
 * Subscribe to a slice. `useSyncExternalStore` compares by reference, and the
 * reducer returns new objects only for the parts that changed, so a panel that
 * selects `state.quests` does not re-render when the player takes a step.
 */
export function useGameSelector<T>(select: (state: GameState) => T): T {
	const engine = getEngine();
	return useSyncExternalStore(
		subscribeToState,
		() => select(engine.getState()),
		() => select(engine.getState()),
	);
}

export function dispatch(command: Parameters<GameEngine["dispatch"]>[0]): void {
	getEngine().dispatch(command);
}
