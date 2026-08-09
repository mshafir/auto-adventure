import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { dispositionLabel } from "../../core/rules/npc.js";
import type { Facing } from "../../core/rules/state.js";
import { clampLine, wrapToLines } from "../render/text.js";
import { useGameState } from "../store.js";

/**
 * Which way you are facing, as one character.
 *
 * The plain arrows, not the emoji-presenting ones from U+2194 up, which
 * terminals may draw double-width. These four are still East-Asian Ambiguous,
 * so a CJK-configured terminal could widen them — a risk contained here because
 * the panel is bordered and truncated, where the same character on the
 * full-width key bar would tear every row below it.
 */
const FACING_ARROW: Readonly<Record<Facing, string>> = {
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
};

/**
 * What the panel says while a reply is being composed.
 *
 * Named rather than a bare "...", because who is thinking is the useful part: in a room
 * with three people in it, a wait with no name on it reads as the game having hung.
 */
function waitingFor(name: string): string {
	return `${name} is thinking...`;
}

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
	/**
	 * Which way the player is facing.
	 *
	 * Shown here because there is nowhere better. Facing decides what SPACE acts
	 * on, so it has to be on screen; it used to be a mark painted on the tile in
	 * front, which worked at a character per tile and does not at forty pixels —
	 * the mark punches a hole through the signpost about to be read. The pixel
	 * renderer puts it on the player's own sprite instead. A single character has
	 * no room for that, so in glyph mode it is said in words, as an arrow in front
	 * of the line describing what is there.
	 */
	readonly facing?: Facing;
	readonly nearbyName?: string;
	/**
	 * Whether the person in front of you is one the story hangs on.
	 *
	 * Said in words as well as in colour. The colour on the map is what finds them
	 * across a street; this is what confirms it once you are standing in front of one,
	 * and it is the version of the fact that survives a colourblind reader or a terminal
	 * themed to within an inch of its life.
	 */
	readonly nearbyIsStory?: boolean;
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
export function DialoguePanel({
	looking,
	facing,
	nearbyName,
	nearbyIsStory,
	width,
	height,
}: DialoguePanelProps) {
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
						<Text color="cyan">{clampLine(nearbyName, inner - 28)}</Text>
						{nearbyIsStory ? " is here, and the story turns on them." : " is here."}
						{" Press SPACE to speak."}
					</Text>
				) : (
					wrapToLines(idle, inner - 2, height - 2).map((text, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
						<Text key={index} color="gray" wrap="truncate">
							{/* Only on the first line, with a space holding the column on the
							    rest, so the prose stays one block rather than stepping in and
							    out around the arrow. */}
							{index === 0 && facing ? (
								<Text bold color="green">{`${FACING_ARROW[facing]} `}</Text>
							) : (
								"  "
							)}
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

	// A reply that is still streaming takes the line's place rather than sitting under it.
	// It is the same sentence the committed line will be, in the same voice and the same
	// rows, so when the turn lands the text stops growing and nothing moves — whereas
	// showing both would put the answer on screen twice and then jump.
	const streaming = dialogue.pending ? dialogue.preview : undefined;
	const spoken = streaming ?? line?.text;
	const asPlayer = !streaming && line?.speaker === "You";

	// The player's own words are prefixed, so they get a narrower budget.
	const speech = spoken ? wrapToLines(spoken, inner - (asPlayer ? 5 : 0), MAX_SPEECH_LINES) : [];

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

			{speech.map((text, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
				<Text key={index} wrap="truncate">
					{index === 0 && asPlayer && <Text color="green">You: </Text>}
					{text}
				</Text>
			))}

			{/* Shown on every turn a reply is being composed, not just the first.
			    This used to be `pending && !line`, which meant it appeared once — on the
			    opening turn, when there was nothing else to draw — and never again: from
			    the second turn on, `line` is the answer the player just gave, so the
			    condition was false and the panel sat there looking finished while a call
			    was in flight. Drawn under the line rather than instead of it, because
			    what the player just said is worth keeping on screen while they wait.

			    In the choices' rows, which are empty exactly while this is showing, so
			    the panel's fixed height is unaffected. */}
			{dialogue.pending && (
				<Text color="gray" wrap="truncate">
					<Spinner type="dots" />
					{` ${clampLine(waitingFor(dialogue.npcName), inner - 2)}`}
				</Text>
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
			{/* A moving spinner rather than the three dots this used to print. A static
			    ellipsis is indistinguishable from a conversation that has stopped, which is
			    the one thing the footer must never be ambiguous about. */}
			{dialogue.pending ? (
				<Text color="gray" wrap="truncate">
					<Spinner type="dots" /> ESC to leave.
				</Text>
			) : (
				<Text color="gray" wrap="truncate">
					{showChoices
						? "UP/DOWN to choose, SPACE to answer, ESC to leave."
						: "SPACE to continue, ESC to leave."}
				</Text>
			)}
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
