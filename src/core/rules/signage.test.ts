import { describe, expect, it } from "vitest";
import { MAX_SIGN_ARMS, type Sign, signBoard, signIndex, signTiles, walkTime } from "./signage.js";

/**
 * What a board says.
 *
 * The whole value of the feature is that this cannot be wrong, so that is what these are
 * about: the direction and the distance are computed from where the places really are, and
 * there is nowhere in the data for an author or a model to write "east" by hand.
 */

const PLACES: Record<number, { name: string; x: number; y: number }> = {
	1: { name: "Aldermoor", x: 0, y: -400 },
	2: { name: "Saltgate", x: 30, y: 0 },
	3: { name: "Cull's Reach", x: -100, y: 100 },
};

const WORLD = {
	nameOf: (siteId: number) => PLACES[siteId]?.name,
	positionOf: (siteId: number) => {
		const place = PLACES[siteId];
		return place ? { x: place.x, y: place.y } : undefined;
	},
};

const sign = (arms: Sign["arms"], rest: Partial<Sign> = {}): Sign => ({
	id: "sign:test",
	x: 0,
	y: 0,
	arms,
	...rest,
});

describe("a signpost", () => {
	it("works out the direction from where the place actually is", () => {
		const board = signBoard(sign([{ siteId: 1 }]), WORLD);
		expect(board).toContain("Aldermoor");
		expect(board).toContain("to the north");
	});

	/*
	 * The reason directions are derived rather than authored, stated as a test. A board is a
	 * tile and a list of site ids; there is no field to disagree with the map, so moving a
	 * town moves every arm pointing at it and nothing has to be kept in step by hand.
	 */
	it("turns round when the place it points at moves", () => {
		const north = signBoard(sign([{ siteId: 1 }]), WORLD);
		const moved = signBoard(sign([{ siteId: 1 }]), {
			...WORLD,
			positionOf: () => ({ x: 0, y: 400 }),
		});
		expect(north).toContain("to the north");
		expect(moved).toContain("to the south");
	});

	it("says how far in a measure somebody holding an arrow key can act on", () => {
		// Saltgate is thirty tiles off and Aldermoor four hundred, so the two arms must not
		// read the same — a board that says only "west" about both is a board that answers
		// half the question.
		const board = signBoard(sign([{ siteId: 2 }, { siteId: 1 }]), WORLD);
		expect(board).toContain("a few minutes' walk");
		expect(board).toContain("a long way off");
	});

	it("reads an arm's own label in preference to the site's name", () => {
		const board = signBoard(sign([{ siteId: 1, label: "the weighing station" }]), WORLD);
		expect(board).toContain("the weighing station");
		expect(board).not.toContain("Aldermoor");
	});

	it("puts the author's note before the arms", () => {
		const board = signBoard(sign([{ siteId: 2 }], { note: "Toll paid at the bridge." }), WORLD);
		expect(board.indexOf("Toll paid")).toBeLessThan(board.indexOf("Saltgate"));
	});

	/*
	 * An arm naming a place this world does not contain is dropped rather than described.
	 * "somewhere: to the north" is worse than a board with one arm on it — the validator
	 * reports the same thing where it can still be fixed.
	 */
	it("leaves off an arm pointing at a place that is not here", () => {
		const board = signBoard(sign([{ siteId: 99 }, { siteId: 2 }]), WORLD);
		expect(board).toContain("Saltgate");
		expect(board).not.toContain("99");
	});

	it("says nothing at all rather than an empty sentence when every arm is gone", () => {
		expect(signBoard(sign([{ siteId: 99 }]), WORLD)).toBe("");
	});

	/*
	 * The cap is the panel, not the fiction: what the player faces is described in two lines
	 * of a fixed-height frame, so a fourth arm is an arm that gets cut off mid-word.
	 */
	it("carries no more arms than the panel can show", () => {
		const board = signBoard(
			sign([{ siteId: 1 }, { siteId: 2 }, { siteId: 3 }, { siteId: 1, label: "Fourth" }]),
			WORLD,
		);
		expect(MAX_SIGN_ARMS).toBe(3);
		expect(board).not.toContain("Fourth");
	});

	it("says you are here rather than pointing at the tile it stands on", () => {
		const board = signBoard(sign([{ siteId: 1 }], { x: 0, y: -400 }), WORLD);
		expect(board).toContain("you are here");
	});
});

describe("the walk", () => {
	it("is coarse on purpose, since a wrong number is worse than a vague one", () => {
		expect(walkTime(10)).toBe("a few minutes' walk");
		expect(walkTime(59)).toBe("a few minutes' walk");
		expect(walkTime(60)).toBe("a fair walk");
		expect(walkTime(249)).toBe("a fair walk");
		expect(walkTime(250)).toBe("a long way off");
	});
});

describe("the sign index", () => {
	it("keys posts by the tile they stand on, for the describe path", () => {
		const posts = [sign([{ siteId: 1 }], { id: "a", x: 4, y: 5 })];
		expect(signIndex(posts).get("4,5")?.id).toBe("a");
		expect(signIndex(posts).get("0,0")).toBeUndefined();
		expect(signIndex(undefined).size).toBe(0);
	});

	it("hands the generator the tiles and nothing else", () => {
		expect(signTiles([sign([{ siteId: 1 }], { x: 7, y: 8 })])).toEqual([{ x: 7, y: 8 }]);
	});
});
