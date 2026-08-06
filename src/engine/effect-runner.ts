import type { Effect } from "../core/rules/effects.js";
import type { SaveRepository } from "../persist/save-repo.js";
import { logger } from "../utils/log.js";
import { ChunkQueue, type Defer } from "./chunk-queue.js";
import type { EngineServices, GameEngine } from "./engine.js";

export interface RunnerDeps {
	readonly saves: SaveRepository;
	/** Fills in names and people around a position. Fire-and-forget. */
	readonly requestSpecs?: (around: { cx: number; cy: number }) => void;
	/** Supplied by the dialogue phase; absent means dialogue is unavailable. */
	readonly runDialogueTurn?: (
		npcId: string,
		choice: string | undefined,
		engine: GameEngine,
	) => Promise<void>;
	readonly summarizeNpc?: (npcId: string, engine: GameEngine) => Promise<void>;
	readonly specFor?: EngineServices["specFor"];
	readonly siteSpec?: EngineServices["siteSpec"];
	readonly content?: EngineServices["content"];
	/**
	 * How the background chunk builder gets its slices of time.
	 *
	 * Defaults to the event loop. A test passes a synchronous one so that a world it
	 * has just walked across is fully built by the time it asserts on it.
	 */
	readonly defer?: Defer;
}

/**
 * Performs effects and reports back by dispatching commands.
 *
 * This is the only place in the game that touches the filesystem or the
 * network. Everything upstream of it is pure, and everything downstream of it
 * re-enters through `dispatch`, so there is no path by which an async result
 * can write state directly.
 */
export function createEffectRunner(deps: RunnerDeps): EngineServices {
	// One per session, because it is the ring around one player.
	const chunks = new ChunkQueue(deps.defer);

	return {
		...(deps.specFor ? { specFor: deps.specFor } : {}),
		...(deps.siteSpec ? { siteSpec: deps.siteSpec } : {}),
		...(deps.content ? { content: deps.content } : {}),
		runEffect(effect: Effect, engine: GameEngine) {
			switch (effect.t) {
				case "EnsureChunk":
					engine.getChunks().ensure(effect.cc.cx, effect.cc.cy);
					return;

				// Lookahead, not what the frame needs: the chunks the camera can see are
				// built before the world opens and kept warm from here, so this is allowed
				// to take its time. See `chunk-queue.ts` for why it must.
				case "PrefetchChunks":
					chunks.want(engine, effect.around, effect.radius);
					return;

				case "RequestSpecs":
					deps.requestSpecs?.(effect.around);
					return;

				case "Save":
					if (effect.reason === "debounced") {
						deps.saves.schedule(engine.getState());
					} else {
						deps.saves.schedule(engine.getState());
						deps.saves.flush();
					}
					return;

				case "RunDialogueTurn": {
					if (!deps.runDialogueTurn) {
						engine.dispatch({
							t: "DialogueTurn",
							npcId: effect.npcId,
							speaker: "",
							text: "They have nothing to say. (No dialogue service is configured.)",
						});
						return;
					}
					return deps.runDialogueTurn(effect.npcId, effect.choice, engine);
				}

				case "SummarizeNpcMemory":
					return deps.summarizeNpc?.(effect.npcId, engine);

				case "Log":
					logger[effect.level](effect.message);
					return;
			}
		},
	};
}
