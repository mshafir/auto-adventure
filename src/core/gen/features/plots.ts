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
	 * returned so the caller can leave them empty — but only when the assignment is
	 * *required*. The blocking pass runs once, before the optional loop, and reads only
	 * `assignments` as populated by then, which is the required search's output alone
	 * (`assignPlots` below); an optional request carrying this relation still keeps
	 * `respectsIsolation`'s protection against anything `assignPlots` places after it, but
	 * contributes nothing to `blocked` itself, so `settlement.ts`'s filler pass — which
	 * only consults `blocked`, not the solver — is free to fill its gap.
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
	/**
	 * Ids of required requests that no plot could satisfy.
	 *
	 * Non-empty means the search failed outright: every requirement is reported here, not
	 * only the one that actually ran out of plots, and `assignments` is still filled with
	 * whatever optional requests fit anyway — a town is better than a hole where a building
	 * should stand, and the invariant report is where the missing building surfaces. So a
	 * caller must check this is empty before trusting `assignments` to be what it asked for.
	 */
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

/** The largest `minGap` any of a request's `Isolated` relations asks for, or 0 if none. */
function isolationOf(request: PlotRequest): number {
	return request.relations.reduce(
		(max, relation) => (relation.t === "Isolated" ? Math.max(max, relation.minGap) : max),
		0,
	);
}

export function assignPlots(context: PlotContext, requests: readonly PlotRequest[]): PlotSolution {
	const { plots } = context;

	/**
	 * Whether a relation holds for a plot, given what has been chosen so far.
	 *
	 * `Isolated` is not decided here — see its case below — so this no longer needs the
	 * plot's index to exclude itself from a neighbour sweep, only the rectangle.
	 */
	const holds = (relation: Relation, plot: Rect, chosen: ReadonlyMap<string, number>): boolean => {
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
				// Isolation is pairwise and symmetric — a property of the distance between two
				// buildings, not of one plot considered alone — so it cannot be decided here
				// against a single candidate. `respectsIsolation` enforces it against every
				// request actually placed so far.
				return true;
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
			return request.relations.every((relation) => holds(relation, plot, chosen));
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

	// Every request placed so far, required or optional, in placement order. Isolation is
	// checked against this rather than `chosen.values()` so nothing about the result depends
	// on Map iteration order, and against every entry rather than only required ones so an
	// optional request can neither crowd nor be crowded by anything already standing.
	const placed: { request: PlotRequest; index: number }[] = [];

	/**
	 * Whether a candidate plot respects every isolation already claimed, and its own.
	 *
	 * Symmetric deliberately: the tower must not land beside a building already placed, and
	 * a building placed later must not land beside the tower. Enforcing one direction only
	 * leaves the fault to whichever order the sort happened to choose.
	 */
	const respectsIsolation = (candidate: PlotRequest, plot: Rect): boolean =>
		placed.every((entry) => {
			const gap = Math.max(isolationOf(candidate), isolationOf(entry.request));
			if (gap <= 0) return true;
			const other = plots[entry.index];
			return other === undefined || rectGap(plot, other) >= gap;
		});

	const place = (at: number): boolean => {
		if (at >= ordered.length) return verified(chosen, ordered);
		const request = ordered[at];
		if (!request) return true;

		for (let index = 0; index < plots.length; index++) {
			if (++nodes > MAX_NODES) return false;
			if (taken.has(index)) continue;
			const plot = plots[index];
			if (!plot || !fitsSize(plot, request)) continue;
			if (!request.relations.every((relation) => holds(relation, plot, chosen))) continue;
			if (!respectsIsolation(request, plot)) continue;

			taken.add(index);
			chosen.set(request.id, index);
			placed.push({ request, index });
			if (place(at + 1)) return true;
			placed.pop();
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
		//
		// Defensive rather than load-bearing: `place`'s own backtracking already unwinds
		// `chosen`, `taken` and `placed` on every failure path, including the MAX_NODES
		// bailout, so by the time it returns false all three are already empty. Clearing
		// them again costs nothing and keeps that invariant from being trusted silently.
		chosen.clear();
		taken.clear();
		placed.length = 0;
		for (const request of ordered) unplaced.push(request.id);
	}

	// Plots an isolated building keeps empty. Collected after the required search, because
	// it depends on where the isolated buildings actually landed. Only *unassigned* plots are
	// blocked — a neighbour already assigned within the gap would mean `respectsIsolation`
	// failed to do its job during placement, not something for this pass to undo.
	const blocked = new Set<number>();
	for (const assignment of assignments) {
		const gap = isolationOf(assignment.request);
		if (gap <= 0) continue;
		const plot = plots[assignment.plot];
		if (!plot) continue;
		plots.forEach((other, index) => {
			if (index === assignment.plot || taken.has(index)) return;
			if (rectGap(plot, other) < gap) blocked.add(index);
		});
	}

	// Then the optional requests, by importance as before, into what is left. Relations and
	// isolation apply here too — nothing in `PlotRequest` says an optional request's wishes
	// are decorative — and each accepted placement is recorded in `chosen` and `placed` so a
	// later optional request can reference it via `Adjacent` or `Isolated`.
	const optional = [...requests.filter((request) => !request.required)].sort(
		(a, b) => b.importance - a.importance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	for (const request of optional) {
		const index = plots.findIndex((plot, i) => {
			if (taken.has(i) || blocked.has(i) || !fitsSize(plot, request)) return false;
			if (!request.relations.every((relation) => holds(relation, plot, chosen))) return false;
			return respectsIsolation(request, plot);
		});
		if (index < 0) continue;
		taken.add(index);
		chosen.set(request.id, index);
		placed.push({ request, index });
		assignments.push({ plot: index, request });
	}

	// Sorted by plot index so the caller iterates plots in a stable order.
	assignments.sort((a, b) => a.plot - b.plot);
	return { assignments, blocked: [...blocked].sort((a, b) => a - b), unplaced: unplaced.sort() };
}
