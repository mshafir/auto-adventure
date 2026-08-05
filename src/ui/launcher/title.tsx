import { Box, Text } from "ink";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { bannerFor } from "./banner.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";

/**
 * The front door.
 *
 * Two choices, because there are only ever two: start something, or go back to
 * something. Everything that used to be on one flat list — which save, which
 * scenario, whether a model writes the world — is a question that only makes sense
 * once you have answered this one, and asking them all at once was why the old
 * screen needed a heading every four rows.
 *
 * Mode-independent by construction: it is text, and it is drawn before the terminal
 * has even been asked whether it does graphics. That ordering is not incidental —
 * the launcher runs, exits, and only then does `main.tsx` probe and start Ink again.
 * It is also why the colour below degrades by depth rather than assuming truecolor:
 * nothing has been established about this terminal yet.
 */

export interface TitleProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	readonly saveCount: number;
	readonly onNew: () => void;
	readonly onContinue: () => void;
	readonly onQuit: () => void;
	readonly isActive?: boolean;
}

export const BYLINE = "by Michael Shafir";
export const CREDIT = "produced with the help of large language models";
export const TAGLINE = "An endless world, written as you walk into it.";

/**
 * The ramp the title is lit with: lamplight down into deep water.
 *
 * Both ends are already in the game's palette — `lamplight` is what a window
 * throws at night and `water` is what the map's rivers are drawn in — so the title
 * is in the same key as the thing behind it rather than being decorated
 * separately. Named here for now; this is exactly the kind of table that belongs
 * in a theme pack.
 */
const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

/** Rows the page needs besides the banner: byline, credit, tagline, menu, footer. */
const CHROME_ROWS = 14;

export function Title({
	columns,
	rows,
	depth,
	saveCount,
	onNew,
	onContinue,
	onQuit,
	isActive = true,
}: TitleProps) {
	const inner = Math.max(20, columns - FRAME_CHROME - 4);

	const items: ChoiceItem[] = [];
	// Continue first when there is something to continue: somebody with a world in
	// progress is almost always here to get back to it.
	if (saveCount > 0) {
		items.push({
			id: "continue",
			label: "Continue",
			detail: saveCount === 1 ? "1 world" : `${saveCount} worlds`,
		});
	}
	items.push({ id: "new", label: "New world" });
	items.push({ id: "quit", label: "Quit" });

	const banner = rampRows(bannerFor(inner, rows - CHROME_ROWS), RAMP, depth);

	return (
		<Frame style="menu" width={columns} height={rows}>
			{/*
			 * Centred both ways, which is the one layout decision that makes this read as
			 * a title screen rather than as a page that happens to start with big text.
			 * `alignItems` shrinks each child to its content, so the menu stays a block
			 * with its own left edge while sitting in the middle of the frame.
			 */}
			<Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
				<Box flexDirection="column" marginBottom={1}>
					{banner.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows of art are positional
						<Text key={index} wrap="truncate">
							{line}
						</Text>
					))}
				</Box>

				{/*
				 * Dropped rather than truncated when the room is not there. A title screen
				 * reading "produced with the h…" looks like a bug; a title screen without a
				 * tagline just looks like a title screen.
				 */}
				{inner >= TAGLINE.length ? (
					<Text color="yellow" wrap="truncate">
						{TAGLINE}
					</Text>
				) : null}
				<Box flexDirection="column" alignItems="center" marginBottom={1}>
					{credits(inner).map((line) => (
						<Text key={line} dimColor wrap="truncate">
							{line}
						</Text>
					))}
				</Box>

				<Box marginBottom={1}>
					<Text color="gray">{divider(Math.min(inner, DIVIDER_WIDTH))}</Text>
				</Box>

				<Chooser
					items={items}
					width={inner}
					isActive={isActive}
					onChoose={(item) => {
						if (item.id === "continue") onContinue();
						else if (item.id === "new") onNew();
						else onQuit();
					}}
					// Esc on the front door is the way out; there is nothing behind it.
					onBack={onQuit}
					onKey={(input) => {
						if (input !== "q") return false;
						onQuit();
						return true;
					}}
				/>
			</Box>

			<Box justifyContent="center">
				<Text dimColor wrap="truncate">
					{"↑↓ move · ENTER choose · Q quit"}
				</Text>
			</Box>
		</Frame>
	);
}

/**
 * The byline and the credit, on one line or two, or just the byline.
 *
 * Both belong on the screen — whose game it is and how it was made — but neither is
 * worth showing half of. Elided mid-word they read as a rendering fault, which is a
 * bad first impression to make on the strength of a narrow window.
 */
function credits(width: number): string[] {
	const together = `${BYLINE} · ${CREDIT}`;
	if (together.length <= width) return [together];
	if (`(${CREDIT})`.length <= width) return [BYLINE, `(${CREDIT})`];
	return [BYLINE];
}

/** Wide enough to separate, short enough not to become the loudest thing on screen. */
const DIVIDER_WIDTH = 44;

/**
 * A rule with a mark in the middle of it.
 *
 * Both characters are Box Drawing and Geometric Shapes, which `glyph-safety.ts`
 * allows — `◆` is not one of the geometric shapes that carries an emoji form, which
 * several of its neighbours in that block do.
 */
function divider(width: number): string {
	const arm = Math.max(1, Math.floor((width - 3) / 2));
	return `${"─".repeat(arm)} ◆ ${"─".repeat(arm)}`;
}
