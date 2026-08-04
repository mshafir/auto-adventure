import { chunkKey, parseChunkKey } from "../world/coords.js";
import { macroSite } from "../world/macro.js";
import { activeQuests, type GameState } from "./state.js";

/**
 * Where the player's open errands are, for the map and the quest list.
 *
 * A grounded, completable quest is still no use if the player cannot find it
 * again: an infinite world has no landmarks to navigate by and the quest log is
 * prose. This turns an open quest into a position.
 *
 * Only discovered chunks are searched, so a marker never appears for a place the
 * player has not been. That is a deliberate limit rather than an omission — the
 * problem worth solving is "which of the towns I have seen was that", not
 * handing out directions to somewhere unvisited.
 */

export interface QuestMark {
	readonly questId: string;
	readonly name: string;
	readonly cx: number;
	readonly cy: number;
}

export function questMarks(state: GameState): readonly QuestMark[] {
	const open = activeQuests(state).filter((quest) => quest.siteId !== undefined);
	if (open.length === 0) return [];

	// Site id to chunk, built by walking the chunks the player has actually seen.
	// A site's position is a pure function of its macro cell, but nothing indexes
	// it the other way round, and building that index for the whole infinite plane
	// is not an option.
	const located = new Map<number, { cx: number; cy: number }>();
	for (const key of state.discovered) {
		const { cx, cy } = parseChunkKey(key);
		const site = macroSite(state.world.seed, cx, cy);
		if (!located.has(site.id)) located.set(site.id, { cx, cy });
	}

	const marks: QuestMark[] = [];
	for (const quest of open) {
		const at = quest.siteId === undefined ? undefined : located.get(quest.siteId);
		if (!at) continue;
		marks.push({ questId: quest.id, name: quest.name, cx: at.cx, cy: at.cy });
	}
	return marks;
}

/** Chunk keys carrying an open quest, for the minimap to mark. */
export function questChunks(state: GameState): ReadonlySet<string> {
	return new Set(questMarks(state).map((mark) => chunkKey(mark.cx, mark.cy)));
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Which way to walk, and roughly how far, in chunks.
 *
 * Chunks rather than tiles because that is the unit the player can act on: "12
 * east" is a number to be endured, "E 1" is a decision. Returns `undefined` when
 * the target is the chunk the player is already standing in, where a direction
 * would be actively misleading.
 */
export function bearingTo(
	fromCx: number,
	fromCy: number,
	toCx: number,
	toCy: number,
): { readonly compass: string; readonly distance: number } | undefined {
	const dx = toCx - fromCx;
	const dy = toCy - fromCy;
	if (dx === 0 && dy === 0) return undefined;

	// Screen coordinates: y grows south, so north is negative and the angle has to
	// be measured from it rather than from the mathematical convention.
	const angle = Math.atan2(dx, -dy);
	const sector = Math.round((angle / (Math.PI * 2)) * 8);
	const compass = COMPASS[((sector % 8) + 8) % 8] as string;

	return { compass, distance: Math.max(Math.abs(dx), Math.abs(dy)) };
}
