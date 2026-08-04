import type { ChunkKey } from "../world/coords.js";
import type { RegionSpec, SiteSpec, SpecSource, WorldLore } from "../world/spec.js";
import type { NpcRecord } from "./npc.js";

export const SAVE_VERSION = 3;

export type Facing = "up" | "down" | "left" | "right";

export interface WorldMeta {
	readonly id: string;
	readonly name: string;
	readonly seed: number;
	readonly createdAt: string;
}

/**
 * Where the player is when they are not in the open world.
 *
 * Interiors are separate grids rather than part of the chunk, so "inside" is a
 * different coordinate space entirely; `returnX`/`returnY` remember the
 * doorstep to step back out onto.
 */
export interface InsidePlace {
	readonly interiorId: number;
	readonly structure: string;
	readonly name?: string;
	readonly returnX: number;
	readonly returnY: number;
}

export interface PlayerState {
	readonly x: number;
	readonly y: number;
	readonly facing: Facing;
	readonly hp: number;
	readonly maxHp: number;
	readonly inside?: InsidePlace;
}

export interface WorldTime {
	/** Advances one per player action. */
	readonly tick: number;
	readonly day: number;
	/** 0..23. Drives lighting and NPC schedules. */
	readonly hour: number;
}

/** How many ticks make an hour. Day and hour are derived from `tick` alone. */
export const TICKS_PER_HOUR = 60;

/** A new world opens at eight in the morning, not at midnight. */
export const START_TICK = 8 * TICKS_PER_HOUR;

export function timeFromTick(tick: number): WorldTime {
	const totalHours = Math.floor(tick / TICKS_PER_HOUR);
	return { tick, day: 1 + Math.floor(totalHours / 24), hour: totalHours % 24 };
}

export interface InventoryItem {
	readonly name: string;
	readonly description: string;
	readonly quantity: number;
}

export type QuestObjectiveKind = "reach" | "talk" | "have" | "flag";

export interface QuestObjective {
	readonly kind: QuestObjectiveKind;
	readonly target: string;
	readonly quantity?: number;
	readonly done: boolean;
}

export interface Quest {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly objectives: readonly QuestObjective[];
	readonly progress: readonly string[];
	readonly completed: boolean;
}

export interface JournalEntry {
	readonly tick: number;
	readonly kind: "lore" | "place" | "rumor" | "event";
	readonly text: string;
	readonly source?: string;
}

/**
 * Player-caused changes to a chunk.
 *
 * Chunk tile arrays are never saved: the generator reproduces them exactly from
 * the seed. Only what the player changed has to persist, which keeps a heavily
 * explored world down to a few hundred kilobytes.
 */
export interface ChunkDelta {
	/** Flat triples of `[localIndex, terrainId, flags]`. */
	readonly tiles?: readonly number[];
	readonly decor?: readonly number[];
	readonly removedEntities?: readonly string[];
}

export interface DialogueLine {
	readonly speaker: string;
	readonly text: string;
}

/**
 * The dialogue *UI queue*, not the model's conversation history.
 *
 * The old design conflated the two in one array, which is why NPC memory could
 * not outlive a conversation: closing the panel destroyed the history along
 * with it. Model history lives per NPC in `npcs` and is persisted; this is
 * discarded on exit and never written to disk.
 */
export interface DialogueState {
	readonly npcId: string;
	readonly npcName: string;
	readonly lines: readonly DialogueLine[];
	readonly cursor: number;
	readonly choices?: readonly string[];
	readonly choiceIndex: number;
	readonly pending: boolean;
}

export interface GameState {
	readonly version: typeof SAVE_VERSION;
	readonly world: WorldMeta;
	readonly player: PlayerState;
	readonly time: WorldTime;
	readonly inventory: readonly InventoryItem[];
	readonly quests: readonly Quest[];
	readonly flags: Readonly<Record<string, string | number | boolean>>;
	readonly journal: readonly JournalEntry[];
	readonly deltas: Readonly<Record<ChunkKey, ChunkDelta>>;
	readonly discovered: readonly ChunkKey[];
	/**
	 * Authored content, keyed by region id and site id.
	 *
	 * These are the expensive part of the world and the only LLM output worth
	 * persisting: tile arrays are reproduced from the seed for free, but a town's
	 * name and its people cost a model call and must survive a restart. Keyed by
	 * *site*, never by chunk — a town straddling four chunks has one spec, which
	 * is the same reason the settlement patch itself is cached by site.
	 */
	readonly lore?: WorldLore;
	readonly regions: Readonly<Record<string, RegionSpec>>;
	readonly sites: Readonly<Record<string, SiteSpec>>;
	readonly specSources: Readonly<Record<string, SpecSource>>;
	/** Everyone the player has ever spoken to, and what they remember. */
	readonly npcs: Readonly<Record<string, NpcRecord>>;
	/** Standing with each named faction, -100..100. Surfaced into prompts. */
	readonly reputation: Readonly<Record<string, number>>;
	readonly dialogue?: DialogueState;
	/**
	 * One line of feedback for something that just happened — searching a crate,
	 * finding it empty.
	 *
	 * UI-facing and never persisted, like `dialogue`, and cleared by the next
	 * command so it reads as a reaction rather than as status.
	 */
	readonly notice?: string;
}

export function createInitialState(world: WorldMeta, spawn: { x: number; y: number }): GameState {
	return {
		version: SAVE_VERSION,
		world,
		player: { x: spawn.x, y: spawn.y, facing: "down", hp: 20, maxHp: 20 },
		time: timeFromTick(START_TICK),
		inventory: [{ name: "Gold", description: "A handful of coins.", quantity: 12 }],
		quests: [],
		flags: {},
		journal: [],
		deltas: {},
		discovered: [],
		regions: {},
		sites: {},
		specSources: {},
		npcs: {},
		reputation: {},
	};
}

export function findItem(state: GameState, name: string): InventoryItem | undefined {
	const lower = name.toLowerCase();
	return state.inventory.find((item) => item.name.toLowerCase() === lower);
}

export function itemCount(state: GameState, name: string): number {
	return findItem(state, name)?.quantity ?? 0;
}

export function activeQuests(state: GameState): readonly Quest[] {
	return state.quests.filter((quest) => !quest.completed);
}
