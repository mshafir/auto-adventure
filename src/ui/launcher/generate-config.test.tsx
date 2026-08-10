import { describe, expect, it } from "vitest";
import { KEY, renderInk } from "../../../test/harness/ink.js";
import type { PackEntry } from "../../content/load.js";
import type { TilePackEntry } from "../../content/tiles.js";
import { GenerateConfig } from "./generate-config.js";

/**
 * The config page on its own, rather than through the launcher.
 *
 * Everything here is about how much room the page has, and reaching it through the
 * launcher means going past a New page that paginates at these heights — so a failure
 * would be about the wrong screen. Rendering the component directly asks only the
 * question being asked.
 */

const PACK: TilePackEntry = {
	name: "gramarye",
	description: "Inked and warm.",
	preview: [
		[{ ch: "a", fg: [1, 2, 3] }],
		[{ ch: "b", fg: [1, 2, 3] }],
		[{ ch: "c", fg: [1, 2, 3] }],
	],
};

function mount(rows: number, tilePacks: readonly TilePackEntry[], contentPacks: PackEntry[] = []) {
	return renderInk(
		<GenerateConfig
			columns={100}
			rows={rows}
			depth="truecolor"
			tilePacks={tilePacks}
			contentPacks={contentPacks}
			onBegin={() => undefined}
			onBack={() => undefined}
		/>,
		{ columns: 100, rows },
	);
}

/** Down until the cursor is on a row, by what is drawn rather than by a press count. */
async function toRow(ink: ReturnType<typeof renderInk>, label: string) {
	for (let i = 0; i < 12; i++) {
		if (ink.screen().includes(`❯ ${label}`)) return;
		await ink.type(KEY.down);
	}
	throw new Error(`never reached "${label}" in:\n${ink.screen()}`);
}

describe("the page that says what to write", () => {
	/**
	 * Ink *clips* an overflowing frame rather than scrolling it, so the symptom of one
	 * row too many is the last choice and the footer silently vanishing — invisible in a
	 * screenshot of a tall terminal, and fatal, because the last choice is the one that
	 * writes the world. The preview costs rows and every setting added to this page costs
	 * another, so the two grow towards each other.
	 */
	for (const rows of [16, 18, 20, 24, 30]) {
		it(`fits a ${rows}-row terminal with a preview showing`, async () => {
			const ink = mount(rows, [PACK]);
			await ink.settle();
			await toRow(ink, "Look");
			const drawn = ink
				.screen()
				.split("\n")
				.filter((line) => line.trim().length > 0);
			expect(drawn.length, `${rows} rows:\n${ink.screen()}`).toBeLessThanOrEqual(rows);
			ink.unmount();
		});
	}

	it("still offers every setting when the bodies have been squeezed out entirely", async () => {
		// A short terminal drops the paragraphs before it drops a choice, which is the
		// right order: a setting you cannot reach is worse than one you cannot read about.
		const ink = mount(16, [PACK]);
		await ink.settle();
		for (const label of ["Length", "Look", "Names and trades", "Write this world"]) {
			expect(ink.screen(), `${label} is missing at 16 rows`).toContain(label);
		}
		ink.unmount();
	});

	it("draws the preview of whichever pack the cursor has landed on", async () => {
		const ink = mount(30, [
			PACK,
			{ name: "inkwell", description: "Sparse.", preview: [[{ ch: "z", fg: [9, 9, 9] }]] },
		]);
		await ink.settle();
		await toRow(ink, "Look");
		await ink.type(KEY.right);
		expect(ink.screen()).toContain("a");
		await ink.type(KEY.right);
		expect(ink.screen()).toContain("z");
		ink.unmount();
	});
});
