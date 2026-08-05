import { Box, Text } from "ink";
import { bannerFor } from "./banner.js";
import { type ChoiceItem, Chooser } from "./chooser.js";

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
 */

export interface TitleProps {
	readonly columns: number;
	readonly saveCount: number;
	readonly onNew: () => void;
	readonly onContinue: () => void;
	readonly onQuit: () => void;
	readonly isActive?: boolean;
}

export const BYLINE = "by Michael Shafir";
export const CREDIT = "produced with the help of large language models";

export function Title({
	columns,
	saveCount,
	onNew,
	onContinue,
	onQuit,
	isActive = true,
}: TitleProps) {
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

	return (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			<Box flexDirection="column" marginBottom={1}>
				{bannerFor(columns - 4).map((line, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows of art are positional
					<Text key={index} color="cyan" wrap="truncate">
						{line}
					</Text>
				))}
			</Box>
			<Text dimColor>{BYLINE}</Text>
			<Box marginBottom={1}>
				<Text dimColor>{`(${CREDIT})`}</Text>
			</Box>

			<Chooser
				items={items}
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

			<Box marginTop={1}>
				<Text dimColor>{"↑↓ move · ENTER choose · Q quit"}</Text>
			</Box>
		</Box>
	);
}
