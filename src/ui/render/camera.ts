/**
 * Where the camera sits, given where the player is.
 *
 * Lives here rather than with the viewport so that the rule is testable and
 * reusable without React and Ink — the same reason `scale.ts` is here.
 */
import type { Camera } from "./compose.js";

/**
 * Centre the camera on a world position.
 *
 * The right answer when there is no previous frame to follow on from, and the
 * one every jump falls back to.
 */
export function cameraCenteredOn(
	position: readonly [number, number],
	width: number,
	height: number,
): Camera {
	return {
		x: position[0] - Math.floor(width / 2),
		y: position[1] - Math.floor(height / 2),
		width,
		height,
	};
}

/**
 * How far in from each edge the dead zone starts, as a fraction of the viewport.
 *
 * The number is a trade, and it is worth stating which way round it runs. A dead
 * zone pins the player against its *leading* edge once they are travelling, so a
 * sustained walk east leaves them east of centre and shows **less** ground ahead
 * than a centred camera does — the price of the world holding still the rest of
 * the time. The smaller the margin the larger the still box and the worse that
 * gets; the closer to a half, the more this is a centred camera with extra steps.
 *
 * At 0.4 the box is a fifth of the viewport — sixteen tiles across at the sizes
 * the game actually runs at, so pacing around a market, turning on the spot or
 * stepping aside for a doorway moves nothing but the player — and a walk still
 * shows two fifths of the screen ahead.
 *
 * `DEAD_ZONE=0.49` is effectively the centred camera this replaced, for anyone
 * who would rather have the look-ahead.
 */
const DEAD_ZONE = (() => {
	const raw = Number(process.env.DEAD_ZONE);
	// Half leaves no dead zone at all, so anything at or above it is a centred
	// camera by another name.
	return Number.isFinite(raw) && raw >= 0 && raw < 0.5 ? raw : 0.4;
})();

/**
 * Follow the player without dragging the whole world along behind them.
 *
 * A centred camera scrolls the entire scene by one tile on *every* step, with the
 * player sprite nailed to the middle — so walking reads as the world sliding
 * underneath rather than as movement, and every footfall repaints every tile.
 *
 * A dead zone inverts that. The player moves within a box in the middle of the
 * viewport and the camera does not move at all; only when they reach the edge of
 * the box does it scroll, by exactly as much as it takes to put them back on that
 * edge. A step taken inside the box changes two tiles — the one they left and the
 * one they arrived on — instead of all of them.
 *
 * What this does *not* do is stop a long walk scrolling. Once the player is
 * pressed against the edge of the box every further step in that direction moves
 * the camera, exactly as before; continuous travel is meant to scroll, and it
 * still does. What goes away is the world lurching for a step taken to look at
 * something, to round a corner, or to line up with a door.
 *
 * `previous` is the camera from the last frame, or undefined when there is none
 * to follow: the first frame, a resize, or a move to somewhere the last camera's
 * coordinates do not mean the same thing, such as stepping indoors.
 *
 * **The result is idempotent**, and it has to be: recomputing from the answer must
 * give back the answer, because React may run a render twice with the same inputs
 * and a camera that crept a tile each time would drift the world away sideways
 * while the player stood still.
 */
export function cameraFollowing(
	previous: Camera | undefined,
	position: readonly [number, number],
	width: number,
	height: number,
): Camera {
	const [x, y] = position;
	if (!previous || previous.width !== width || previous.height !== height) {
		return cameraCenteredOn(position, width, height);
	}
	// Off the edge of the world we were looking at is a teleport, not a step —
	// entering a building, loading a save, a beat moving the player. Sliding to it
	// would leave them pressed against the border of a scene they just arrived in.
	if (x < previous.x || x >= previous.x + width || y < previous.y || y >= previous.y + height) {
		return cameraCenteredOn(position, width, height);
	}

	return {
		x: slide(previous.x, x, width),
		y: slide(previous.y, y, height),
		width,
		height,
	};
}

/**
 * One axis of the dead zone.
 *
 * The margin is capped at half the span so that a viewport too small to hold a
 * dead zone degrades to a centred camera rather than to an inverted one.
 */
function slide(origin: number, at: number, span: number): number {
	const margin = Math.min(Math.floor(span * DEAD_ZONE), Math.floor((span - 1) / 2));
	const low = origin + margin;
	const high = origin + span - 1 - margin;
	if (at < low) return at - margin;
	if (at > high) return at - (span - 1 - margin);
	return origin;
}
