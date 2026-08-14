import { describe, expect, it } from "vitest";
import { cameraCenteredOn, cameraFollowing, cameraTowards } from "./camera.js";

const W = 40;
const H = 20;

/** Where the player sits inside the viewport, which is what the rule is about. */
function offset(camera: { x: number; y: number }, x: number, y: number) {
	return { x: x - camera.x, y: y - camera.y };
}

describe("a camera with nothing to follow", () => {
	it("centres on the player", () => {
		const camera = cameraCenteredOn([100, 50], W, H);
		expect(offset(camera, 100, 50)).toEqual({ x: W / 2, y: H / 2 });
	});

	it("centres when there is no previous frame", () => {
		expect(cameraFollowing(undefined, [100, 50], W, H)).toEqual(cameraCenteredOn([100, 50], W, H));
	});

	it("centres again when the viewport changes size", () => {
		const before = cameraFollowing(undefined, [100, 50], W, H);
		const after = cameraFollowing(before, [100, 50], W + 6, H);
		expect(after).toEqual(cameraCenteredOn([100, 50], W + 6, H));
	});
});

describe("the dead zone", () => {
	it("does not move for a step taken inside it", () => {
		// The whole point: the world stays still while the player walks across the
		// middle of it, so a footfall reads as movement rather than as the ground
		// sliding underneath.
		const start = cameraFollowing(undefined, [100, 50], W, H);
		const next = cameraFollowing(start, [101, 50], W, H);
		expect({ x: next.x, y: next.y }).toEqual({ x: start.x, y: start.y });
		expect(offset(next, 101, 50).x).toBe(offset(start, 100, 50).x + 1);
	});

	it("scrolls by exactly one tile once the player reaches the edge of it", () => {
		let camera = cameraFollowing(undefined, [100, 50], W, H);
		let at = 100;
		// Walk east until it gives, and check it gave by one rather than by a jump.
		while (cameraFollowing(camera, [at + 1, 50], W, H).x === camera.x) {
			at += 1;
			expect(at).toBeLessThan(100 + W); // the loop must terminate
		}
		const scrolled = cameraFollowing(camera, [at + 1, 50], W, H);
		expect(scrolled.x).toBe(camera.x + 1);
		camera = scrolled;
		// And keeps giving one at a time for as long as the player keeps going.
		expect(cameraFollowing(camera, [at + 2, 50], W, H).x).toBe(camera.x + 1);
	});

	it("still shows a substantial view in the direction of travel", () => {
		/*
		 * The cost of a dead zone, pinned so it cannot quietly get worse.
		 *
		 * Travelling east leaves the player against the *east* edge of the box, so
		 * they see less ahead than a centred camera would give them — that is the
		 * trade, not a bug. What must hold is that "less" stays a large fraction of
		 * the screen: shrink the margin and the still box grows, but the player ends
		 * up walking into a wall of viewport edge.
		 */
		let camera = cameraFollowing(undefined, [100, 50], W, H);
		for (let at = 101; at < 140; at++) camera = cameraFollowing(camera, [at, 50], W, H);
		const ahead = W - offset(camera, 139, 50).x;
		expect(ahead / W).toBeGreaterThanOrEqual(0.35);
	});

	it("holds the player still on the screen while the world scrolls", () => {
		// Past the edge of the dead zone the player is pinned and the ground moves,
		// which is the classic scrolling camera and what makes a long walk readable.
		let camera = cameraFollowing(undefined, [100, 50], W, H);
		for (let at = 101; at <= 130; at++) camera = cameraFollowing(camera, [at, 50], W, H);
		const settled = offset(camera, 130, 50).x;
		camera = cameraFollowing(camera, [131, 50], W, H);
		expect(offset(camera, 131, 50).x).toBe(settled);
	});

	it("is symmetric: west mirrors east", () => {
		let east = cameraFollowing(undefined, [100, 50], W, H);
		for (let at = 101; at <= 140; at++) east = cameraFollowing(east, [at, 50], W, H);
		let west = cameraFollowing(undefined, [100, 50], W, H);
		for (let at = 99; at >= 60; at--) west = cameraFollowing(west, [at, 50], W, H);
		// The player's offset going one way is the mirror of it going the other, or
		// the view lurches differently depending on which way you walked into it.
		expect(offset(west, 60, 50).x).toBe(W - 1 - offset(east, 140, 50).x);
	});

	it("moves the two axes independently", () => {
		// Walking east must not scroll the view north. They are separate clamps and
		// coupling them would swing the camera diagonally on a straight walk.
		let camera = cameraFollowing(undefined, [100, 50], W, H);
		for (let at = 101; at <= 130; at++) camera = cameraFollowing(camera, [at, 50], W, H);
		expect(camera.y).toBe(cameraCenteredOn([100, 50], W, H).y);
	});
});

describe("jumps", () => {
	it("recentres when the player lands outside the view", () => {
		// A doorway, a loaded save, a beat that moves them. Sliding would leave them
		// pressed against the border of a scene they have only just arrived in.
		const before = cameraFollowing(undefined, [100, 50], W, H);
		const after = cameraFollowing(before, [4000, 4000], W, H);
		expect(after).toEqual(cameraCenteredOn([4000, 4000], W, H));
	});

	it("slides rather than recentring for a jump that lands in view", () => {
		const before = cameraFollowing(undefined, [100, 50], W, H);
		const after = cameraFollowing(before, [100 + W / 2 - 1, 50], W, H);
		expect(after.x).not.toBe(cameraCenteredOn([100 + W / 2 - 1, 50], W, H).x);
	});
});

describe("stability", () => {
	/*
	 * The property the app depends on. React may render twice with the same state,
	 * and the camera is computed during render from the frame before it — so a rule
	 * that moved on its own answer would drift the world sideways a tile per render
	 * while the player stood perfectly still.
	 */
	it("returns its own answer unchanged", () => {
		let camera = cameraFollowing(undefined, [100, 50], W, H);
		for (const [x, y] of [
			[100, 50],
			[118, 50],
			[119, 61],
			[80, 40],
			[81, 41],
		] as const) {
			camera = cameraFollowing(camera, [x, y], W, H);
			expect(cameraFollowing(camera, [x, y], W, H)).toEqual(camera);
		}
	});

	it("keeps the player on screen wherever they walk", () => {
		let camera = cameraFollowing(undefined, [0, 0], W, H);
		let x = 0;
		let y = 0;
		for (let step = 0; step < 500; step++) {
			// A deterministic wander, so a failure is reproducible.
			x += ((step * 7) % 3) - 1;
			y += ((step * 5) % 3) - 1;
			camera = cameraFollowing(camera, [x, y], W, H);
			expect(x).toBeGreaterThanOrEqual(camera.x);
			expect(x).toBeLessThan(camera.x + W);
			expect(y).toBeGreaterThanOrEqual(camera.y);
			expect(y).toBeLessThan(camera.y + H);
		}
	});
});

describe("a viewport too small to hold a dead zone", () => {
	it("degrades to a centred camera rather than an inverted one", () => {
		for (const span of [1, 2, 3]) {
			let camera = cameraFollowing(undefined, [0, 0], span, span);
			for (let at = 1; at < 6; at++) {
				camera = cameraFollowing(camera, [at, at], span, span);
				expect(at).toBeGreaterThanOrEqual(camera.x);
				expect(at).toBeLessThan(camera.x + span);
			}
		}
	});
});

describe("panning a scene's camera", () => {
	const size = [21, 11] as const;

	it("centres outright when there is no camera to pan from", () => {
		expect(cameraTowards(undefined, [50, 50], ...size, 1)).toEqual(
			cameraCenteredOn([50, 50], ...size),
		);
	});

	it("goes straight there at a rate of zero, which is what a cut is", () => {
		const held = cameraCenteredOn([0, 0], ...size);
		expect(cameraTowards(held, [50, 50], ...size, 0)).toEqual(cameraCenteredOn([50, 50], ...size));
	});

	it("moves the stated number of tiles per call", () => {
		const held = cameraCenteredOn([0, 0], ...size);
		const goal = cameraCenteredOn([9, 0], ...size);
		const once = cameraTowards(held, [9, 0], ...size, 3);
		expect(once.x).toBe(held.x + 3);
		expect(once.x).not.toBe(goal.x);
	});

	it("arrives exactly, rather than oscillating past the target", () => {
		// A pan that overshot would rock back and forth for the rest of the scene.
		let camera = cameraCenteredOn([0, 0], ...size);
		const goal = cameraCenteredOn([4, 0], ...size);
		for (let frame = 0; frame < 10; frame++) camera = cameraTowards(camera, [4, 0], ...size, 3);
		expect(camera).toEqual(goal);
	});

	it("pans both axes at once", () => {
		const held = cameraCenteredOn([0, 0], ...size);
		const next = cameraTowards(held, [20, 20], ...size, 2);
		expect(next.x).toBe(held.x + 2);
		expect(next.y).toBe(held.y + 2);
	});

	it("re-centres on a resize rather than panning to a camera of the wrong shape", () => {
		const held = cameraCenteredOn([0, 0], 21, 11);
		expect(cameraTowards(held, [0, 0], 31, 15, 1)).toEqual(cameraCenteredOn([0, 0], 31, 15));
	});
});
