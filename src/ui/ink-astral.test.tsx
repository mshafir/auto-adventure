import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

/**
 * Ink cannot lay out characters outside the BMP, and the kitty graphics
 * protocol requires one.
 *
 * A placeholder is U+10EEEE, which JavaScript stores as a surrogate pair — two
 * UTF-16 code units for one display column. `string-width` gets this right, and
 * Ink uses it to *measure*, so Yoga sizes the box correctly. But when Ink then
 * writes the text into that box it slices by code unit, so a row of N
 * placeholders is cut to N/2 and everything laid out to its right is composited
 * into the hole that leaves.
 *
 * In the game that put the side panel through the middle of the map. These
 * tests exist so the limitation is recorded as a fact about Ink rather than
 * rediscovered as a rendering bug, and so it is obvious if a future Ink fixes
 * it — this file will start failing.
 */
const PH = String.fromCodePoint(0x10_ee_ee);
const WIDTH = 20;

/** How many placeholders survive when the row has no neighbour beside it. */
function aloneCount(fill: string): number {
	const { lastFrame } = render(
		<Box flexDirection="column" width={WIDTH}>
			<Text>{fill.repeat(WIDTH)}</Text>
		</Box>,
	);
	const line = (lastFrame() ?? "").split("\n")[0] ?? "";
	return line.split(fill).length - 1;
}

function siblingColumn(fill: string): number {
	const { lastFrame } = render(
		<Box width={WIDTH + 10}>
			<Box width={WIDTH} flexShrink={0}>
				<Text>{fill.repeat(WIDTH)}</Text>
			</Box>
			<Box width={10} flexShrink={0}>
				<Text>SIDEPANEL!</Text>
			</Box>
		</Box>,
	);
	const line = (lastFrame() ?? "").split("\n")[0] ?? "";
	const at = line.indexOf("S");
	return stringWidth(line.slice(0, at));
}

describe("Ink and astral-plane characters", () => {
	it("measures a placeholder as one column, which is correct", () => {
		expect(stringWidth(PH)).toBe(1);
		// ...but it is two code units, and that is the whole problem.
		expect(PH.length).toBe(2);
	});

	it("puts an ASCII row's sibling where it belongs", () => {
		expect(siblingColumn("x")).toBe(WIDTH);
	});

	/**
	 * The bug, stated as itself. If this ever starts failing because the sibling
	 * lands at WIDTH, Ink has been fixed and the viewport can go back to letting
	 * it lay the placeholder grid out.
	 */
	it("loses half of a row of placeholders", () => {
		const at = siblingColumn(PH);
		expect(at).toBe(WIDTH / 2);
		expect(at).not.toBe(WIDTH);
	});

	/**
	 * And this is the way out. The slicing is a *compositing* fault, not a
	 * measuring one: Ink only cuts the row when it has to place something to the
	 * right of it on the same screen line. A row that owns its line survives
	 * whole.
	 *
	 * That is why the map cannot share rows with a side panel in pixel mode, and
	 * why anything that has to appear over the map — a minimap, an overlay — has
	 * to be composited into the frame itself rather than laid out beside it.
	 */
	it("keeps every placeholder when nothing shares the row", () => {
		expect(aloneCount(PH)).toBe(WIDTH);
	});
});
