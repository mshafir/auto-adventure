import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { dispositionLabel } from "../../core/rules/npc.js";
import { clampLine, wrapToLines } from "../render/text.js";
import { useGameState } from "../store.js";

/** Replies offered at once. The schema caps the model at this too. */
const MAX_CHOICES = 4;
/** Lines of speech shown before the rest is cut. */
const MAX_SPEECH_LINES = 3;

/**
 * Rows the panel occupies, border included.
 *
 * Two fixed sizes rather than one that grows with its content. A panel that
 * grows can push the frame to the full height of the terminal, and Ink responds
 * to that by clearing the whole screen on every keypress instead of rewriting
 * the lines that changed — which the player sees as flicker. Two sizes keep the
 * total fixed while giving the map back the rows a conversation is not using.
 */
export const DIALOGUE_HEIGHT = 2 + 1 + MAX_SPEECH_LINES + MAX_CHOICES + 1;
/** The same panel showing only what the player is looking at. */
export const LOOKING_HEIGHT = 2 + 2;

export function panelHeightFor(inConversation: boolean): number {
	return inConversation ? DIALOGUE_HEIGHT : LOOKING_HEIGHT;
}

export interface DialoguePanelProps {
	/** What the player is looking at, shown when no conversation is open. */
	readonly looking?: string;
	readonly nearbyName?: string;
	/** Outer width, so text can be clamped to what actually fits. */
	readonly width: number;
	/** Outer height, border included. Must match {@link panelHeightFor}. */
	readonly height: number;
}

/**
 * The conversation panel.
 *
 * Deliberately choice-driven: the model proposes two to four options and the
 * player picks one. There is no free-text field — being able to type would make
 * the model's job easier but would break the tone the game is going for.
 */
export function DialoguePanel({ looking, nearbyName, width, height }: DialoguePanelProps) {
	const state = useGameState();
	const dialogue = state.dialogue;
	// Border and horizontal padding come off before anything is measured.
	const inner = Math.max(8, width - 4);

	if (!dialogue) {
		const idle = looking ?? "Use the arrow keys to move.";
		return (
			<Frame height={height}>
				{nearbyName ? (
					<Text wrap="truncate">
						<Text color="cyan">{clampLine(nearbyName, inner - 28)}</Text> is here. Press SPACE to
						speak.
					</Text>
				) : (
					wrapToLines(idle, inner, height - 2).map((text, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
						<Text key={index} color="gray" wrap="truncate">
							{text}
						</Text>
					))
				)}
			</Frame>
		);
	}

	const line = dialogue.lines[dialogue.cursor];
	const showChoices = !dialogue.pending && dialogue.choices && dialogue.choices.length > 0;
	const record = state.npcs[dialogue.npcId];
	const choices = dialogue.choices?.slice(0, MAX_CHOICES) ?? [];

	// The player's own words are prefixed, so they get a narrower budget.
	const speech = line
		? wrapToLines(line.text, inner - (line.speaker === "You" ? 5 : 0), MAX_SPEECH_LINES)
		: [];

	return (
		<Frame height={height} borderColor="cyan">
			<Text bold color="cyan" wrap="truncate">
				{dialogue.npcName}
				{/* Surfacing the relationship is what makes memory legible: without
				    it, disposition is a number in a save file nobody ever sees. */}
				{record && record.totalTurns > 0 && (
					<Text color="gray">
						{" "}
						— {dispositionLabel(record.disposition)}, met {record.totalTurns} times
					</Text>
				)}
			</Text>

			{dialogue.pending && !line ? (
				<Text color="gray">
					<Spinner type="dots" /> ...
				</Text>
			) : (
				speech.map((text, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
					<Text key={index} wrap="truncate">
						{index === 0 && line?.speaker === "You" && <Text color="green">You: </Text>}
						{text}
					</Text>
				))
			)}

			{showChoices &&
				choices.map((choice, index) => (
					<Text
						key={choice}
						color={index === dialogue.choiceIndex ? "yellow" : "gray"}
						wrap="truncate"
					>
						{index === dialogue.choiceIndex ? "> " : "  "}
						{clampLine(choice, inner - 2)}
					</Text>
				))}

			<Box flexGrow={1} />
			<Text color="gray" wrap="truncate">
				{showChoices
					? "UP/DOWN to choose, SPACE to answer, ESC to leave."
					: dialogue.pending
						? "..."
						: "SPACE to continue, ESC to leave."}
			</Text>
		</Frame>
	);
}

/** The fixed-height shell. Every branch above renders into exactly this. */
function Frame({
	children,
	height,
	borderColor = "gray",
}: {
	children: React.ReactNode;
	height: number;
	borderColor?: string;
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={borderColor}
			paddingX={1}
			height={height}
			flexShrink={0}
		>
			{children}
		</Box>
	);
}
