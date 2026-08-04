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

export function bindEngine(engine: GameEngine): void {
	engineRef = engine;
}

export function getEngine(): GameEngine {
	if (!engineRef) throw new Error("engine not bound; call bindEngine() before rendering");
	return engineRef;
}

export function useGameState(): GameState {
	const engine = getEngine();
	return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
}

/**
 * Subscribe to a slice. `useSyncExternalStore` compares by reference, and the
 * reducer returns new objects only for the parts that changed, so a panel that
 * selects `state.quests` does not re-render when the player takes a step.
 */
export function useGameSelector<T>(select: (state: GameState) => T): T {
	const engine = getEngine();
	return useSyncExternalStore(
		engine.subscribe,
		() => select(engine.getState()),
		() => select(engine.getState()),
	);
}

export function dispatch(command: Parameters<GameEngine["dispatch"]>[0]): void {
	getEngine().dispatch(command);
}
