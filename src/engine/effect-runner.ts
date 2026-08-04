import type { Effect } from "../core/rules/effects.js";
import type { SaveRepository } from "../persist/save-repo.js";
import { logger } from "../utils/log.js";
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
	return {
		...(deps.specFor ? { specFor: deps.specFor } : {}),
		...(deps.siteSpec ? { siteSpec: deps.siteSpec } : {}),
		...(deps.content ? { content: deps.content } : {}),
		runEffect(effect: Effect, engine: GameEngine) {
			switch (effect.t) {
				case "EnsureChunk":
					engine.getChunks().ensure(effect.cc.cx, effect.cc.cy);
					return;

				case "PrefetchChunks": {
					const built = engine.getChunks().prefetch(effect.around, effect.radius);
					// Newly-built chunks may carry anchors that people belong at.
					if (built.length > 0) engine.populateNpcs(effect.around);
					for (const key of built) engine.dispatch({ t: "ChunkReady", key });
					return;
				}

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
