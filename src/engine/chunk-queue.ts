/**
 * Build the ring of chunks around the player a slice at a time.
 *
 * Generating one chunk costs about 28ms — measured, and it is the pipeline's
 * whole cost, not a hot spot in it — and a step used to prefetch a 5x5 square
 * synchronously inside the effect drain. Steady state that is 25 cache hits and
 * free; cross a chunk boundary and it is five fresh chunks, so the process went
 * away for **140ms** the moment the player walked over a seam, plus a re-render
 * per chunk on top. That is the lurch, and it is not the renderer.
 *
 * The work itself cannot be avoided — the world is generated, and somebody has to
 * pay for it. What can be avoided is paying for all of it between one keypress and
 * the next. So the ring is built here instead: nearest chunk first, one per turn of
 * the event loop, with `setImmediate` yielding to stdin in between. Total cost is
 * unchanged; the largest pause it can cause is one chunk instead of five, and the
 * player keeps moving through it.
 *
 * That works because the ring is *lookahead*. The chunks the camera can actually
 * see are built before the world opens ({@link GameEngine} does a synchronous
 * radius-1 prefetch) and kept warm by this queue thereafter, so by the time the
 * player reaches a seam the ground past it is usually already there. When it is
 * not — a teleport, a save loaded somewhere new — nearest-first means the tiles on
 * screen are the ones built first, and the step that walks into genuinely
 * ungenerated ground still has `EnsureChunk` to build it on the spot.
 */
import { type ChunkCoord, type ChunkKey, chunkKey } from "../core/world/coords.js";
import type { GameEngine } from "./engine.js";

/** How the queue asks for its next slice of time. Injected so tests can drive it. */
export type Defer = (task: () => void) => void;

/**
 * A slice, by default, is the next turn of the event loop.
 *
 * `setImmediate` rather than a timer because it wants whatever time is spare
 * rather than a delay, and because its callbacks run in the check phase — after
 * the poll phase, so a keystroke that arrived while a chunk was being built is
 * handled before the next one starts.
 *
 * Unref'd so that work left in the queue cannot hold the process open after the
 * player has quit. An abandoned chunk is not lost: generation is deterministic and
 * it will be rebuilt on demand.
 */
const soon: Defer = (task) => {
	setImmediate(task).unref();
};

/**
 * Chunks per slice.
 *
 * One, because one chunk is already about 28ms and the point of this is to be
 * interruptible. `CHUNK_SLICE` raises it for a machine fast enough to want the ring
 * warmed sooner.
 */
const PER_SLICE = (() => {
	const raw = Number(process.env.CHUNK_SLICE);
	return Number.isInteger(raw) && raw >= 1 ? raw : 1;
})();

export class ChunkQueue {
	private queue: ChunkCoord[] = [];
	private centre: ChunkCoord = { cx: 0, cy: 0 };
	private scheduled = false;

	constructor(private readonly defer: Defer = soon) {}

	/** What is still waiting to be built. For tests and for the diagnostics. */
	get pending(): number {
		return this.queue.length;
	}

	/**
	 * Ask for a square of chunks around a position, without waiting for them.
	 *
	 * Recomputed from scratch each time rather than appended to, because this is
	 * called on every step and the answer moves with the player: a chunk that was
	 * the far corner of the ring two steps ago may not be wanted at all now, and
	 * one that was outside it is suddenly the nearest thing missing.
	 */
	want(engine: GameEngine, around: ChunkCoord, radius: number): void {
		const chunks = engine.getChunks();
		const wanted: ChunkCoord[] = [];
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const cx = around.cx + dx;
				const cy = around.cy + dy;
				if (!chunks.has(cx, cy)) wanted.push({ cx, cy });
			}
		}
		// Nearest first, so whatever the camera can see is built before the lookahead
		// behind it. Squared distance: the ordering is all that is being asked for and
		// a square root would not change it.
		wanted.sort(
			(a, b) =>
				(a.cx - around.cx) ** 2 +
				(a.cy - around.cy) ** 2 -
				((b.cx - around.cx) ** 2 + (b.cy - around.cy) ** 2),
		);

		this.queue = wanted;
		this.centre = around;
		if (wanted.length > 0) this.schedule(engine);
	}

	/**
	 * Build everything outstanding now.
	 *
	 * For a caller that genuinely cannot proceed without the ground — and for tests,
	 * which would otherwise have to pump an event loop to assert on a world.
	 */
	flush(engine: GameEngine): void {
		while (this.queue.length > 0) this.slice(engine);
	}

	private schedule(engine: GameEngine): void {
		if (this.scheduled) return;
		this.scheduled = true;
		this.defer(() => {
			this.scheduled = false;
			if (this.queue.length === 0) return;
			this.slice(engine);
			if (this.queue.length > 0) this.schedule(engine);
		});
	}

	/**
	 * One slice of building, and one notification for all of it.
	 *
	 * The keys go out as a single command deliberately. Every `ChunkReady` that
	 * discovers new ground is a state change, and every state change is a full
	 * re-render and a re-uploaded frame — so dispatching per chunk made crossing a
	 * seam cost five renders nobody could see the difference between.
	 */
	private slice(engine: GameEngine): void {
		const built: ChunkKey[] = [];
		for (let n = 0; n < PER_SLICE && this.queue.length > 0; n++) {
			const next = this.queue.shift() as ChunkCoord;
			// Something else may have built it in the meantime — a step onto it, a
			// settlement rebuild — and `ensure` is a cache hit then, not a second copy.
			const fresh = !engine.getChunks().has(next.cx, next.cy);
			engine.getChunks().ensure(next.cx, next.cy);
			if (fresh) built.push(chunkKey(next.cx, next.cy));
		}
		if (built.length === 0) return;
		// New ground may carry anchors that people belong at.
		engine.populateNpcs(this.centre);
		engine.dispatch({ t: "ChunkReady", keys: built });
	}
}
