import { describe, expect, it } from "vitest";
import { createInitialState, type GameState, worldAnchor } from "./state.js";

/**
 * The one question that has been answered wrong five times.
 *
 * Indoors the player's coordinates are local to the interior grid. A bower at
 * (-1, -122) reads as (5, 7) while you are standing in it, so *every* question asked
 * in world or chunk space — which chunk to keep loaded, which building has this
 * interior id, which way is the errand, what is on the minimap — silently answers
 * about a place near the origin instead of about where the player actually is.
 *
 * Nothing throws. The interior grid is small and near the origin, so the answer is a
 * real chunk somewhere out in the wilderness, and every symptom looks like a different
 * bug: the Lady missing from her own bower, the quest arrow pointing at nothing, the
 * minimap centred on empty fen. This is the shared cause, pinned once.
 */

function standing(x: number, y: number): GameState {
	return createInitialState({ id: "t", name: "t", seed: 1, createdAt: "" }, { x, y });
}

function indoors(at: { x: number; y: number }, local: { x: number; y: number }): GameState {
	const base = standing(at.x, at.y);
	return {
		...base,
		player: {
			...base.player,
			x: local.x,
			y: local.y,
			inside: {
				interiorId: 42,
				structure: "house",
				name: "The Lady's Bower",
				returnX: at.x,
				returnY: at.y,
			},
		},
	};
}

describe("where the player is, when they are not standing in the world", () => {
	it("is their own position outdoors", () => {
		expect(worldAnchor(standing(-1, -122).player)).toEqual({ x: -1, y: -122 });
	});

	it("is the doorstep indoors, not the tile they occupy in the room", () => {
		// The doorstep is the honest answer: it is the tile they will step back out onto,
		// it is inside the settlement they are in, and it is a real world coordinate.
		expect(worldAnchor(indoors({ x: -1, y: -122 }, { x: 5, y: 7 }).player)).toEqual({
			x: -1,
			y: -122,
		});
	});

	it("never answers with the interior's own coordinates", () => {
		// The shape of every one of these bugs: the local position is a *valid* world
		// coordinate, so nothing rejects it and the wrong answer looks like a right one.
		const local = { x: 5, y: 7 };
		const anchor = worldAnchor(indoors({ x: 300, y: -240 }, local).player);
		expect(anchor).not.toEqual(local);
		expect(anchor).toEqual({ x: 300, y: -240 });
	});
});
