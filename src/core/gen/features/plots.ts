import { dist, type Rect, rectCenter, type Vec2 } from "../../geom/vec.js";
import { minimumPlot } from "./building.js";
import type { StructureKind } from "./patch.js";

/**
 * Which building goes on which plot, decided rather than hoped for.
 *
 * This replaces the block `settlement.ts` described as advisory: "more structures than
 * plots are truncated by importance and fewer are padded with filler, so a malformed or
 * oversized spec degrades instead of failing". Degrading instead of failing is the right
 * instinct for a malformed spec and the wrong one for a story: a plot too small for the
 * requested counting house handed the plot to filler, so the building the story sends
 * the player to find was a house, and nothing anywhere said so.
 *
 * So requirements are solved *first*, by search, and filler takes only what is left.
 * Filler can no longer outbid a requirement because it never competes for the same plot.
 *
 * Knows nothing about patches, worlds or settlements, and takes its own input types
 * rather than importing `StructureSpec`. Partly to avoid the import cycle with
 * `settlement.ts`, and partly because a solver that needs a generated world to be tested
 * is a solver that will not be tested at the edges.
 */

/** Where a building has to be, relative to the town or to another building. */
export type Relation =
	/** Within `within` tiles of the square, for something civic. */
	| { readonly t: "OnSquare"; readonly within: number }
	/** Out towards the edge of the footprint, for something nobody wants next door. */
	| { readonly t: "AtEdge" }
	/** Within `within` tiles of the street the player arrives by. */
	| { readonly t: "OnArrivalStreet"; readonly within: number }
	/** Within `within` tiles of another request, by id. */
	| { readonly t: "Adjacent"; readonly to: string; readonly within: number }
	/**
	 * No other building within `minGap` tiles.
	 *
	 * Costs plots rather than merely constraining one: filler would otherwise build right
	 * up against a hermit's tower and the isolation would last until the next pass. So an
	 * isolated assignment also *blocks* the plots inside its gap, and those plots are
	 * returned so the caller can leave them empty.
	 */
	| { readonly t: "Isolated"; readonly minGap: number };

export interface PlotRequest {
	readonly id: string;
	readonly kind: StructureKind;
	readonly size: "small" | "medium" | "large";
	/** 1..5. Orders optional requests only; a requirement is not outranked. */
	readonly importance: number;
	readonly required: boolean;
	readonly relations: readonly Relation[];
}

export interface PlotContext {
	/** Candidate plots, in the caller's preferred order (largest first, today). */
	readonly plots: readonly Rect[];
	readonly square: Vec2;
	/** Where roads enter the footprint, for `OnArrivalStreet`. */
	readonly gates: readonly Vec2[];
	readonly centre: Vec2;
	readonly radius: number;
}

export interface PlotAssignment {
	/** Index into {@link PlotContext.plots}. */
	readonly plot: number;
	readonly request: PlotRequest;
}

export interface PlotSolution {
	readonly assignments: readonly PlotAssignment[];
	/** Plot indices that must be left empty, from an `Isolated` requirement. */
	readonly blocked: readonly number[];
	/** Ids of required requests that no plot could satisfy. */
	readonly unplaced: readonly string[];
}

/**
 * How far apart two rectangles are, zero when they touch or overlap.
 *
 * Chebyshev rather than Euclidean, because it is measuring a gap between footprints on a
 * tile grid: two buildings offset diagonally by one tile are neighbours.
 */
export function rectGap(a: Rect, b: Rect): number {
	const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
	const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
	return Math.max(dx, dy);
}

/**
 * A ceiling on the search.
 *
 * Six requirements over thirty plots is solved in microseconds and nothing in this game
 * asks for more, but a bad spec should cost a bounded amount rather than a hang: this is
 * generation, and it runs inside a chunk request.
 */
const MAX_NODES = 20_000;

function fitsSize(plot: Rect, request: PlotRequest): boolean {
	const need = minimumPlot(request.kind, request.size);
	return plot.w >= need.x && plot.h >= need.y;
}

export function assignPlots(context: PlotContext, requests: readonly PlotRequest[]): PlotSolution {
	const { plots } = context;

	/**
	 * Whether a relation holds for a plot, given what has been chosen so far.
	 *
	 * Takes the plot's *index* as well as the rectangle. `Isolated` has to exclude the
	 * plot from its own neighbour sweep, and finding it by `indexOf` would compare by
	 * reference — correct today and quietly wrong the moment a caller passes two plots
	 * that happen to be equal rectangles.
	 */
	const holds = (
		relation: Relation,
		at: number,
		plot: Rect,
		chosen: ReadonlyMap<string, number>,
	): boolean => {
		switch (relation.t) {
			case "OnSquare":
				return dist(rectCenter(plot), context.square) <= relation.within;
			case "AtEdge":
				return dist(rectCenter(plot), context.centre) >= context.radius * 0.6;
			case "OnArrivalStreet":
				return context.gates.some((gate) => dist(rectCenter(plot), gate) <= relation.within);
			case "Adjacent": {
				const other = chosen.get(relation.to);
				// Not yet placed: nothing to measure against, so allow it here and let the
				// final check below settle it. Allowing early keeps the search complete —
				// rejecting an unmeasurable relation would prune the only valid ordering.
				if (other === undefined) return true;
				const target = plots[other];
				return target !== undefined && rectGap(plot, target) <= relation.within;
			}
			case "Isolated":
				return plots.every(
					(other, index) => index === at || rectGap(plot, other) >= relation.minGap,
				);
		}
	};

	/**
	 * Every relation of every placed request, re-checked against the finished assignment.
	 *
	 * `Adjacent` is allowed through above when its target is not yet placed, so a
	 * complete assignment has to be verified once at the end. Without this the solver
	 * would accept a pair whose adjacency was never actually measured.
	 */
	const verified = (
		chosen: ReadonlyMap<string, number>,
		subject: readonly PlotRequest[],
	): boolean =>
		subject.every((request) => {
			const index = chosen.get(request.id);
			if (index === undefined) return false;
			const plot = plots[index];
			if (!plot) return false;
			return request.relations.every((relation) => {
				if (relation.t !== "Adjacent") return holds(relation, index, plot, chosen);
				const other = chosen.get(relation.to);
				if (other === undefined) return true;
				const target = plots[other];
				return target !== undefined && rectGap(plot, target) <= relation.within;
			});
		});

	// Required first, and among them the most constrained first — fewest candidate plots,
	// then most important, then by id. Sorting on explicit keys rather than relying on the
	// caller's order is what makes the result a function of the inputs alone.
	const required = requests.filter((request) => request.required);
	const domainOf = (request: PlotRequest): number =>
		plots.filter((plot) => fitsSize(plot, request)).length;
	const ordered = [...required].sort(
		(a, b) =>
			domainOf(a) - domainOf(b) ||
			b.importance - a.importance ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);

	const chosen = new Map<string, number>();
	const taken = new Set<number>();
	let nodes = 0;

	const place = (at: number): boolean => {
		if (at >= ordered.length) return verified(chosen, ordered);
		const request = ordered[at];
		if (!request) return true;

		for (let index = 0; index < plots.length; index++) {
			if (++nodes > MAX_NODES) return false;
			if (taken.has(index)) continue;
			const plot = plots[index];
			if (!plot || !fitsSize(plot, request)) continue;
			if (!request.relations.every((relation) => holds(relation, index, plot, chosen))) continue;

			taken.add(index);
			chosen.set(request.id, index);
			if (place(at + 1)) return true;
			chosen.delete(request.id);
			taken.delete(index);
		}
		return false;
	};

	const solved = place(0);
	const assignments: PlotAssignment[] = [];
	const unplaced: string[] = [];

	if (solved) {
		for (const request of ordered) {
			const index = chosen.get(request.id);
			if (index === undefined) unplaced.push(request.id);
			else assignments.push({ plot: index, request });
		}
	} else {
		// No complete assignment. Report every requirement as unplaced rather than
		// shipping a partial one: a settlement missing one of three required buildings is
		// a fault the caller must see, and a half-solution hides which half is missing.
		chosen.clear();
		taken.clear();
		for (const request of ordered) unplaced.push(request.id);
	}

	// Plots an isolated building keeps empty. Collected after the search, because it
	// depends on where the isolated buildings actually landed.
	const blocked = new Set<number>();
	for (const assignment of assignments) {
		const gap = assignment.request.relations.find((relation) => relation.t === "Isolated");
		if (!gap || gap.t !== "Isolated") continue;
		const plot = plots[assignment.plot];
		if (!plot) continue;
		plots.forEach((other, index) => {
			if (index === assignment.plot || taken.has(index)) return;
			if (rectGap(plot, other) < gap.minGap) blocked.add(index);
		});
	}

	// Then the optional requests, by importance as before, into what is left.
	const optional = [...requests.filter((request) => !request.required)].sort(
		(a, b) => b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	for (const request of optional) {
		const index = plots.findIndex(
			(plot, i) => !taken.has(i) && !blocked.has(i) && fitsSize(plot, request),
		);
		if (index < 0) continue;
		taken.add(index);
		assignments.push({ plot: index, request });
	}

	// Sorted by plot index so the caller iterates plots in a stable order.
	assignments.sort((a, b) => a.plot - b.plot);
	return { assignments, blocked: [...blocked].sort((a, b) => a - b), unplaced: unplaced.sort() };
}
