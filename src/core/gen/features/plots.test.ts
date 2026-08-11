import { describe, expect, it } from "vitest";
import type { Rect } from "../../geom/vec.js";
import { assignPlots, type PlotContext, type PlotRequest } from "./plots.js";

/** A row of plots of increasing size, so "too small for this" is easy to arrange. */
function context(sizes: readonly number[]): PlotContext {
	const plots: Rect[] = sizes.map((size, i) => ({ x: i * 40, y: 0, w: size, h: size }));
	return { plots, square: { x: 0, y: 0 }, gates: [], centre: { x: 0, y: 0 }, radius: 60 };
}

function request(over: Partial<PlotRequest> = {}): PlotRequest {
	return {
		id: over.id ?? "r1",
		kind: over.kind ?? "house",
		size: over.size ?? "small",
		importance: over.importance ?? 3,
		required: over.required ?? false,
		relations: over.relations ?? [],
	};
}

describe("assignPlots", () => {
	it("gives a required structure a plot even when an optional one wants it more", () => {
		// One plot big enough for a hall. The optional request has higher importance, and
		// under the old importance-sort it took the plot and the required one got filler.
		const ctx = context([13, 6]);
		const solution = assignPlots(ctx, [
			request({ id: "needed", kind: "hall", size: "medium", required: true, importance: 1 }),
			request({ id: "wanted", kind: "hall", size: "medium", required: false, importance: 5 }),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments.find((a) => a.request.id === "needed")).toBeDefined();
	});

	it("reports a required structure it could not place rather than dropping it", () => {
		const ctx = context([6, 6]);
		const solution = assignPlots(ctx, [
			request({ id: "needed", kind: "hall", size: "large", required: true }),
		]);

		expect(solution.unplaced).toEqual(["needed"]);
		expect(solution.assignments).toEqual([]);
	});

	it("is deterministic: the same input gives the same assignment every time", () => {
		const ctx = context([13, 12, 11, 10, 9, 8, 7]);
		const requests = [
			request({ id: "a", kind: "inn", required: true }),
			request({ id: "b", kind: "smithy", required: true }),
			request({ id: "c", kind: "shop", required: false }),
		];

		const first = assignPlots(ctx, requests);
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(assignPlots(ctx, requests)).toEqual(first);
		}
	});

	it("backtracks when a greedy first choice would strand a later requirement", () => {
		// Two plots. Both requests fit plot 0; only one fits plot 1. A greedy pass that
		// hands plot 0 to the first request strands the second, so the solver must
		// reconsider.
		const ctx = context([13, 7]);
		const solution = assignPlots(ctx, [
			request({ id: "small-one", kind: "shop", size: "small", required: true }),
			request({ id: "big-one", kind: "hall", size: "medium", required: true }),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments).toHaveLength(2);
	});
});

describe("assignPlots: the sort that makes the result a function of the inputs alone", () => {
	it("breaks a domain/importance tie by id, regardless of the order the caller lists requests in", () => {
		// Two identical plots, two requests that fit both equally (same domain, same
		// importance) — the *only* thing that can decide who gets plot 0 is the id
		// tiebreak. The request array is passed in the reverse of id order ("zeta" before
		// "alpha"): if the assignment matched the input order instead of the id order, this
		// would catch it. A test that listed the requests alphabetically to begin with
		// would pass whether or not the tiebreak existed, which is exactly the trap this is
		// built to avoid.
		const ctx = context([10, 10]);
		const zeta = request({
			id: "zeta",
			kind: "house",
			size: "small",
			required: true,
			importance: 3,
		});
		const alpha = request({
			id: "alpha",
			kind: "house",
			size: "small",
			required: true,
			importance: 3,
		});

		const solution = assignPlots(ctx, [zeta, alpha]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments.find((a) => a.request.id === "alpha")?.plot).toBe(0);
		expect(solution.assignments.find((a) => a.request.id === "zeta")?.plot).toBe(1);
	});
});

describe("assignPlots: genuine backtracking", () => {
	it("undoes an earlier placement that turns out to strand a later, relation-bound requirement", () => {
		// Three plots, sized so the domain-ordering heuristic alone still picks the wrong
		// plot for "a-hall" on the first try:
		//   - P0 (8x6) fits only a-hall (needs 8x6).           domain(a-hall) = {P0, P1} = 2
		//   - P1 (8x7) fits both a-hall and b-shop.             domain(b-shop) = {P1, P2} = 2
		//   - P2 (7x7) fits only b-shop (needs 7x7).
		// a-hall is ordered first (tied domain, higher importance) and, on a plain greedy
		// first-fit, takes P0 — the lowest-index plot that fits it. b-shop must then sit
		// within 3 tiles of a-hall, but P1 and P2 are both far from P0, so that choice
		// strands b-shop and the search only succeeds by undoing it and retrying a-hall on
		// P1, which is a doorstep away from P2.
		//
		// A solver that sorts by domain but never backtracks — assign each request to its
		// first fit and never revisit — reproduces exactly that failure: it places a-hall on
		// P0, then reports b-shop unplaced. Only genuine backtracking (try P0, fail deeper,
		// undo, try P1) finds the solution, which is what this test checks for.
		const ctx: PlotContext = {
			plots: [
				{ x: 0, y: 0, w: 8, h: 6 }, // P0
				{ x: 50, y: 0, w: 8, h: 7 }, // P1
				{ x: 58, y: 0, w: 7, h: 7 }, // P2
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 400,
		};

		const solution = assignPlots(ctx, [
			request({
				id: "b-shop",
				kind: "shop",
				size: "medium",
				required: true,
				importance: 3,
				relations: [{ t: "Adjacent", to: "a-hall", within: 3 }],
			}),
			request({
				id: "a-hall",
				kind: "hall",
				size: "small",
				required: true,
				importance: 5,
				relations: [],
			}),
		]);

		expect(solution.unplaced).toEqual([]);
		const aHall = solution.assignments.find((a) => a.request.id === "a-hall");
		const bShop = solution.assignments.find((a) => a.request.id === "b-shop");
		expect(aHall?.plot).toBe(1);
		expect(bShop?.plot).toBe(2);
	});
});

describe("relations", () => {
	it("puts an OnSquare requirement near the square and not across town", () => {
		const ctx: PlotContext = {
			plots: [
				{ x: 200, y: 200, w: 13, h: 13 },
				{ x: 4, y: 4, w: 13, h: 13 },
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 60,
		};

		const solution = assignPlots(ctx, [
			request({
				id: "temple",
				kind: "temple",
				size: "medium",
				required: true,
				relations: [{ t: "OnSquare", within: 30 }],
			}),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments[0]?.plot).toBe(1);
	});

	it("keeps an Isolated requirement's neighbours empty", () => {
		// Plot 0 and plot 1 are 3 tiles apart (well under minGap 20); plot 2 is 288 tiles
		// from both. The tower has nothing placed yet to conflict with, so it takes the
		// first plot that fits its size (plot 0) — isolation is not "go to the emptiest
		// corner", it is "keep anything else out of the gap once you've landed". That gap
		// then has to swallow plot 1, and only plot 2 is left for the optional request.
		//
		// Asserting `blocked` is non-empty and names plot 1 specifically is what makes this
		// test able to fail: the previous version of this test asserted `blocked` was `[]`,
		// which passed whether the blocking pass existed or not.
		const ctx: PlotContext = {
			plots: [
				{ x: 0, y: 0, w: 9, h: 9 },
				{ x: 12, y: 0, w: 9, h: 9 },
				{ x: 300, y: 0, w: 9, h: 9 },
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 400,
		};

		const solution = assignPlots(ctx, [
			request({
				id: "tower",
				kind: "tower",
				size: "small",
				required: true,
				relations: [{ t: "Isolated", minGap: 20 }],
			}),
			request({ id: "filler-ish", kind: "house", size: "small", required: false }),
		]);

		const tower = solution.assignments.find((a) => a.request.id === "tower");
		expect(tower?.plot).toBe(0);
		expect(solution.blocked).toEqual([1]);
		expect(solution.assignments.find((a) => a.request.id === "filler-ish")?.plot).toBe(2);
	});

	it("puts an AtEdge requirement away from the centre, not next to it", () => {
		const ctx: PlotContext = {
			plots: [
				{ x: 0, y: 0, w: 9, h: 9 },
				{ x: 200, y: 0, w: 9, h: 9 },
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 100,
		};

		const solution = assignPlots(ctx, [
			request({
				id: "edge-house",
				kind: "house",
				size: "small",
				required: true,
				relations: [{ t: "AtEdge" }],
			}),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments[0]?.plot).toBe(1);
	});

	it("puts an OnArrivalStreet requirement near a gate, not far from every gate", () => {
		const ctx: PlotContext = {
			plots: [
				{ x: 0, y: 0, w: 9, h: 9 },
				{ x: 100, y: 100, w: 9, h: 9 },
			],
			square: { x: 0, y: 0 },
			gates: [{ x: 104, y: 104 }],
			centre: { x: 0, y: 0 },
			radius: 60,
		};

		const solution = assignPlots(ctx, [
			request({
				id: "gatehouse",
				kind: "house",
				size: "small",
				required: true,
				relations: [{ t: "OnArrivalStreet", within: 20 }],
			}),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments[0]?.plot).toBe(1);
	});

	it("lets a required Adjacent-to relation through when its target never gets a plot", () => {
		// "ghost" names no request in this call at all, so the target is unmeasurable —
		// documented in plots.ts as deliberate: rejecting an unmeasurable relation during
		// search would prune the only valid ordering. The relation must not block placement,
		// neither during search nor in the final `verified()` pass.
		const ctx = context([9]);
		const solution = assignPlots(ctx, [
			request({
				id: "lonely",
				kind: "house",
				size: "small",
				required: true,
				relations: [{ t: "Adjacent", to: "ghost", within: 5 }],
			}),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments[0]?.plot).toBe(0);
	});

	it("honours an optional request's own relations rather than filling it in first-fit", () => {
		// Plot 0 is nearer the top of the list but fails OnSquare; plot 1 fits the size just
		// as well and satisfies it. The old fill loop for optional requests checked only
		// size and occupancy, never `holds`, so it would have handed this to plot 0 — the
		// first fit — and silently ignored the relation. There is no required request in
		// this call at all, so the only way plot 1 gets chosen is if the optional loop itself
		// enforces the relation.
		const ctx: PlotContext = {
			plots: [
				{ x: 200, y: 200, w: 13, h: 13 },
				{ x: 4, y: 4, w: 13, h: 13 },
			],
			square: { x: 0, y: 0 },
			gates: [],
			centre: { x: 0, y: 0 },
			radius: 60,
		};

		const solution = assignPlots(ctx, [
			request({
				id: "optional-square",
				kind: "house",
				size: "small",
				required: false,
				relations: [{ t: "OnSquare", within: 30 }],
			}),
		]);

		expect(solution.unplaced).toEqual([]);
		expect(solution.assignments.find((a) => a.request.id === "optional-square")?.plot).toBe(1);
	});
});
