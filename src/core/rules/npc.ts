/**
 * What an NPC remembers.
 *
 * The old design kept one array that was simultaneously the model's message
 * history and the UI's message queue, which is why nobody could remember
 * anything: closing the panel discarded the conversation, and narrator notices
 * ("You have added 3 Gold") were pushed in as `role: assistant` and fed back to
 * the model as things the NPC had said. These two roles are now separate types
 * living in separate places — this one is persisted per NPC and survives ESC,
 * a reload and the chunk being evicted; `DialogueState` is the transient queue.
 *
 * The whole thing hinges on ids being stable, which they are because they are
 * derived from `(siteId, slot)` and both are deterministic.
 */

export interface NpcTurn {
	readonly role: "player" | "npc";
	readonly text: string;
}

export interface NpcRecord {
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly siteId: number;
	/** -100..100. Surfaced into the prompt, so memory changes behaviour. */
	readonly disposition: number;
	/** Rolling prose summary of everything older than `recentTurns`. */
	readonly summary: string;
	/** Durable things they learned about the player. */
	readonly facts: readonly string[];
	/** The last few exchanges, verbatim. */
	readonly recentTurns: readonly NpcTurn[];
	readonly totalTurns: number;
	readonly lastSeenTick: number;
	readonly flags: Readonly<Record<string, boolean>>;
}

/** Verbatim turns kept before summarisation folds the oldest away. */
export const MAX_RECENT_TURNS = 12;
/** How many are folded at a time. */
export const SUMMARY_BATCH = 6;
export const MAX_FACTS = 12;

export function createNpcRecord(seed: {
	id: string;
	name: string;
	role: string;
	siteId: number;
	disposition?: number;
}): NpcRecord {
	return {
		id: seed.id,
		name: seed.name,
		role: seed.role,
		siteId: seed.siteId,
		disposition: clampDisposition(seed.disposition ?? 0),
		summary: "",
		facts: [],
		recentTurns: [],
		totalTurns: 0,
		lastSeenTick: 0,
		flags: {},
	};
}

export function clampDisposition(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(-100, Math.min(100, Math.round(value)));
}

/** Whether enough has accumulated to be worth a summarisation call. */
export function needsSummary(record: NpcRecord): boolean {
	return record.recentTurns.length > MAX_RECENT_TURNS - SUMMARY_BATCH;
}

export function dispositionLabel(value: number): string {
	if (value >= 60) return "devoted";
	if (value >= 25) return "warm";
	if (value >= 8) return "friendly";
	if (value > -8) return "neutral";
	if (value > -25) return "guarded";
	if (value > -60) return "hostile";
	return "implacable";
}
