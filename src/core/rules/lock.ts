import type { Condition } from "./condition.js";

/**
 * Something in the way until something else is true.
 *
 * Two shapes, because a barred shop door and a barred town gate are not the same
 * problem even though they read the same way to the player.
 *
 * A {@link Lock} sits on a *door* — a transition into an interior. Refusing it
 * changes nothing about the world: the door was already drawn closed, the player
 * simply does not go through. Nothing has to be persisted, and the same door in
 * a regenerated chunk is locked again for free, because the lock travels with the
 * building's spec rather than with the tile.
 *
 * A {@link Barrier} sits on a *tile* in the open world — a gate across a road, a
 * portcullis in a gatehouse. That one has to change: once it opens it stays open,
 * visibly, and the tile under it becomes walkable. So it is the one case that
 * writes into the world, through the delta map that already exists for exactly
 * this — player-caused changes to a chunk, in state rather than in cache.
 */
export interface Lock {
	/** What has to be true to get through. */
	readonly opensWhen: Condition;
	/** What the player is told when it is not. One line, in the world's voice. */
	readonly lockedText: string;
}

export interface Barrier {
	/** Stable id. Becomes `barrier:<id>` in the flags once opened. */
	readonly id: string;
	/**
	 * Every tile this gate stands on, opening together.
	 *
	 * A list rather than a single position, because a road is rarely one tile wide. A
	 * gate on the middle tile of a three-wide cobbled road is not a gate — the player
	 * walks round it, and nothing in the game says so. One flag covers the whole span,
	 * so the whole span lifts on the step that satisfies it.
	 */
	readonly tiles: readonly { readonly x: number; readonly y: number }[];
	readonly opensWhen: Condition;
	readonly lockedText: string;
	/** Said once, as the way opens. Absent means open it without comment. */
	readonly opensText?: string;
}

/** The flag recording that a barrier has been opened. */
export function barrierKey(id: string): string {
	return `barrier:${id}`;
}

export function barrierOpen(flags: Readonly<Record<string, unknown>>, id: string): boolean {
	return Boolean(flags[barrierKey(id)]);
}

/**
 * Index barriers by position.
 *
 * The reducer asks "is there a barrier on this tile" on every step, so the lookup
 * has to be a map rather than a scan of the list. Built once when the world is
 * opened, which is also where a barrier outside the boundary would be caught.
 */
export function barrierIndex(barriers: readonly Barrier[] | undefined): Map<string, Barrier> {
	const index = new Map<string, Barrier>();
	for (const barrier of barriers ?? []) {
		for (const tile of barrier.tiles) index.set(`${tile.x},${tile.y}`, barrier);
	}
	return index;
}

/** Every tile every gate stands on, for the generator to stamp. */
export function barrierTiles(
	barriers: readonly Barrier[] | undefined,
): readonly { readonly x: number; readonly y: number }[] {
	return (barriers ?? []).flatMap((barrier) => barrier.tiles);
}
