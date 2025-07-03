import type { GameState } from "../game-store.js";

export type Action<Args extends unknown[]> = (
	state: GameState,
	...args: Args
) => Promise<Partial<GameState>> | Partial<GameState>;

export function defineAction<Args extends unknown[]>(action: Action<Args>) {
	return action;
}
