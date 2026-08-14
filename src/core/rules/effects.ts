import type { ChunkCoord } from "../world/coords.js";
import type { Card } from "./card.js";
import type { CachedTurn } from "./dialogue-cache.js";
import type { NpcTurn } from "./npc.js";
import type { Facing, JournalEntry, QuestObjective } from "./state.js";

/**
 * Pure state changes.
 *
 * `DomainEffect` is deliberately a *data* description rather than a function.
 * It is what LLM tool calls are translated into, so the model's influence on
 * the game is confined to producing values from this closed set — it can ask
 * for an item to be granted, but it cannot reach into the store and write one.
 * These are applied synchronously by the reducer.
 */
export type DomainEffect =
	| {
			readonly t: "GrantItem";
			readonly name: string;
			readonly description: string;
			readonly quantity: number;
	  }
	| { readonly t: "TakeItem"; readonly name: string; readonly quantity: number }
	| { readonly t: "AdjustGold"; readonly amount: number }
	| {
			readonly t: "CreateQuest";
			readonly id: string;
			readonly name: string;
			readonly description: string;
			readonly objectives: readonly QuestObjective[];
			/** Where it was given, so it can be marked on the map. */
			readonly siteId?: number;
			/** The errand this is a step of, for the quest pane's nesting. */
			readonly parentId?: string;
	  }
	| { readonly t: "AdvanceQuest"; readonly id: string; readonly note: string }
	| { readonly t: "CompleteQuest"; readonly id: string }
	| { readonly t: "AbandonQuest"; readonly id: string }
	| { readonly t: "SetFlag"; readonly key: string; readonly value: string | number | boolean }
	/**
	 * Put a full screen of prose in front of the player.
	 *
	 * Ignored if this card's id has already been read. That check lives in the
	 * reducer rather than in the callers because the callers are the places least
	 * able to know: a beat re-applied after a partial save, a session resumed, an
	 * arrival re-entered. One idempotent effect is cheaper than five careful guards.
	 */
	| { readonly t: "ShowCard"; readonly card: Card }
	| { readonly t: "AdjustDisposition"; readonly npcId: string; readonly delta: number }
	| { readonly t: "AdjustReputation"; readonly faction: string; readonly delta: number }
	/** Create the memory record for an NPC the player has just met. */
	| {
			readonly t: "MeetNpc";
			readonly npcId: string;
			readonly name: string;
			readonly role: string;
			readonly siteId: number;
			readonly disposition: number;
	  }
	/** Append one exchange to an NPC's verbatim history. */
	| { readonly t: "RecordTurn"; readonly npcId: string; readonly turn: NpcTurn }
	/**
	 * Keep a generated reply so the same moment never costs a second call.
	 *
	 * Separate from `RecordTurn`, which is what the *NPC* remembers and is folded into a
	 * summary as it ages. This is what the *world* remembers, verbatim and unfolded,
	 * because a reply that has been paraphrased is no longer the same reply.
	 */
	| { readonly t: "RememberTurn"; readonly key: string; readonly turn: CachedTurn }
	// Where a scripted conversation has got to. Its own effect rather than a flag so
	// the cursor lives with the rest of what an NPC remembers.
	| { readonly t: "SetNpcNode"; readonly npcId: string; readonly node: string }
	/** Replace the rolling summary, folding away the turns it now covers. */
	| {
			readonly t: "FoldNpcMemory";
			readonly npcId: string;
			readonly summary: string;
			readonly newFacts: readonly string[];
			readonly foldedTurns: number;
	  }
	| { readonly t: "RecordJournal"; readonly entry: Omit<JournalEntry, "tick"> }
	/**
	 * Let a gate stand open, for good.
	 *
	 * The one effect that changes the *world* rather than the player's situation, and
	 * it does it through the delta map — which already exists for precisely this, and
	 * is already the reason a heavily-explored world stays a few hundred kilobytes.
	 * The flag is what a condition can read; the delta is what the renderer and the
	 * passability check see. Both go down together so the two cannot disagree.
	 */
	| { readonly t: "OpenBarrier"; readonly id: string }
	/**
	 * Hand the world over to a scene, by id.
	 *
	 * Ignored when a scene is already playing. The guard against playing one *twice* is not
	 * here but on the trigger that raised it: a trigger whose effects include this keeps its
	 * fired flag unwritten until the scene finishes, so an interrupted cutscene replays
	 * rather than being silently lost. See `playsAScene` and `closeScene`.
	 */
	| { readonly t: "PlayScene"; readonly id: string }
	| { readonly t: "Teleport"; readonly x: number; readonly y: number }
	| { readonly t: "Damage"; readonly amount: number }
	| { readonly t: "Heal"; readonly amount: number }
	| { readonly t: "EndDialogue" };

/**
 * Requests for the outside world: anything asynchronous, or anything that
 * touches the filesystem or the network. The reducer only ever *returns* these;
 * the effect runner is what performs them, and it reports back by dispatching
 * another command.
 */
export type Effect =
	| { readonly t: "EnsureChunk"; readonly cc: ChunkCoord }
	| { readonly t: "PrefetchChunks"; readonly around: ChunkCoord; readonly radius: number }
	/** Ask the director for names and people around a position, and freeze the
	 * layout of anything close enough to see. */
	| { readonly t: "RequestSpecs"; readonly around: ChunkCoord }
	| { readonly t: "RunDialogueTurn"; readonly npcId: string; readonly choice?: string }
	| { readonly t: "SummarizeNpcMemory"; readonly npcId: string }
	| { readonly t: "Save"; readonly reason: "debounced" | "exit" | "checkpoint" }
	| {
			readonly t: "Log";
			readonly level: "debug" | "info" | "warn" | "error";
			readonly message: string;
	  };

export interface Reduction {
	readonly state: import("./state.js").GameState;
	readonly effects: readonly Effect[];
}

export const FACINGS: readonly Facing[] = ["up", "right", "down", "left"];

export function facingDelta(facing: Facing): readonly [number, number] {
	switch (facing) {
		case "up":
			return [0, -1];
		case "down":
			return [0, 1];
		case "left":
			return [-1, 0];
		case "right":
			return [1, 0];
	}
}
