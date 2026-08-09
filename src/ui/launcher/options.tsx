import { Box, Text } from "ink";
import { useState } from "react";
import { CATALOGUE, costLabel, modelChoice, priceLine } from "../../ai/catalogue.js";
import { maskKey } from "../../persist/settings.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";
import { TextField } from "./text-field.js";

/**
 * The settings that belong to the machine rather than to a world.
 *
 * There are only two, and they are here together because they are the same
 * question asked twice: what is allowed to write this world, and how good does it
 * have to be. Neither belongs on the config page — that page is about a world
 * being made now, and both of these outlive every world made on this machine.
 *
 * It is also the answer to the game's worst first impression. Without a key the
 * launcher offers a procedural world and a note saying why the good one is
 * missing, and the note names an environment variable the player has to go and
 * find a shell to set. Now the note points at a screen.
 */

const CHROME = FRAME_CHROME + 4;

/** The heading, the blank under it, the status line, its blank, and the footer. */
const PAGE_CHROME = 5;

const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

const HEADING = "Options";

export interface OptionsProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	/** The key as it currently stands, from the environment or from settings. */
	readonly gatewayKey?: string;
	/**
	 * Whether that key came from the environment.
	 *
	 * An environment variable outranks the settings file, so a player who edits the
	 * key here and sees nothing change has been told a lie. The page says so
	 * instead, and refuses to pretend it can help.
	 */
	readonly keyFromEnv?: boolean;
	readonly modelSet?: string;
	/** Where the key is written, shown so it can be found, edited or deleted. */
	readonly settingsPath: string;
	readonly onSaveKey: (key: string) => void;
	readonly onChooseModel: (id: string) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

export function Options({
	columns,
	rows,
	depth,
	gatewayKey,
	keyFromEnv = false,
	modelSet,
	settingsPath,
	onSaveKey,
	onChooseModel,
	onBack,
	isActive = true,
}: OptionsProps) {
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState(false);
	// What the last action did, shown under the list. Cleared by starting another
	// one, so it always describes the most recent thing the player pressed.
	const [note, setNote] = useState<string | undefined>(undefined);

	const chosen = modelChoice(modelSet);
	const ids = CATALOGUE.map((entry) => entry.id);

	const keyDetail = gatewayKey
		? keyFromEnv
			? `${maskKey(gatewayKey)} — from the environment`
			: maskKey(gatewayKey)
		: "not set";

	const items: ChoiceItem[] = [
		{
			id: "key",
			label: "AI gateway key",
			detail: keyDetail,
			body: keyFromEnv
				? "AI_GATEWAY_API_KEY is set in this shell, and a real environment variable always wins. Unset it to manage the key here instead."
				: gatewayKey
					? `Your Vercel AI Gateway key. Kept in ${settingsPath}, readable only by you, and never in the repository. ENTER to replace it.`
					: `Without one the game still runs, but every world is procedural — no authored towns and no written conversations. Get one at vercel.com/ai-gateway; it is kept in ${settingsPath}, readable only by you.`,
			...(keyFromEnv ? { disabled: true } : {}),
		},
		...(gatewayKey && !keyFromEnv
			? [
					{
						id: "forget",
						label: "Forget the key",
						body: "Deletes it from the settings file. The game keeps working; it just stops writing worlds.",
					} satisfies ChoiceItem,
				]
			: []),
		{
			id: "model",
			label: "Model",
			detail: `${chosen.label} · ${costLabel(chosen)}`,
			body: `${chosen.note} ${describe(chosen.id)}`,
			rule: "Which model writes",
		},
		{
			id: "done",
			label: "Done",
			accent: "green",
		},
	];

	const cycle = (item: ChoiceItem | undefined, step: -1 | 1): void => {
		if (item?.id !== "model") return;
		const at = ids.indexOf(chosen.id);
		const to = ((at < 0 ? 0 : at) + step + ids.length) % ids.length;
		const next = ids[to] as string;
		onChooseModel(next);
		setNote(undefined);
	};

	const heading = rampRows([HEADING], RAMP, depth)[0] ?? HEADING;

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text dimColor>{"  kept for every world, on this machine"}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					// Deafened rather than unmounted while the key is being typed, for the
					// same reason the config page does it: the cursor lives inside `Chooser`,
					// and taking it away would send the player back to the top of the page
					// every time they touched the key.
					isActive={isActive && !editing}
					onBack={onBack}
					onCycle={cycle}
					onChoose={(item) => {
						if (item.id === "key") {
							// Started empty rather than pre-filled with the existing key. A field
							// you have to clear before typing is a field that eventually saves
							// half of an old key spliced onto a new one.
							setDraft("");
							setNote(undefined);
							setEditing(true);
							return;
						}
						if (item.id === "forget") {
							onSaveKey("");
							setNote("Key forgotten. Worlds will be procedural from here.");
							return;
						}
						if (item.id === "done") {
							onBack();
							return;
						}
						cycle(item, 1);
					}}
				/>
			</Box>

			{editing ? (
				<TextField
					value={draft}
					onChange={setDraft}
					placeholder="paste your AI gateway key"
					// Masked as it is typed. A key on screen is a key in whatever recording
					// or screen-share is running, and this is the one field in the game where
					// that matters.
					mask
					maxLength={200}
					onSubmit={(value) => {
						setEditing(false);
						const trimmed = value.trim();
						if (!trimmed) {
							setNote("Nothing typed; the key is unchanged.");
							return;
						}
						onSaveKey(trimmed);
						setDraft("");
						setNote("Saved. A live world is on offer now.");
					}}
					onCancel={() => {
						setEditing(false);
						setDraft("");
					}}
				/>
			) : (
				<Text wrap="truncate">
					{note ? (
						<Text color="green">{note}</Text>
					) : (
						<Text
							dimColor
						>{`Models are billed by the gateway, not by this game. ${priceLine(chosen.prose.price)} for what you read.`}</Text>
					)}
				</Text>
			)}

			<Text dimColor wrap="truncate">
				{editing
					? "Pasting works. ENTER to save it, ESC to leave the key alone."
					: "↑↓ move · ←→ change · ENTER choose · ESC back"}
			</Text>
		</Frame>
	);
}

/** The provider and the two models, for the paragraph under the model row. */
function describe(id: string): string {
	const choice = modelChoice(id);
	const same = choice.fast.model === choice.prose.model;
	return same
		? `${choice.provider}; ${choice.prose.model} throughout, ${priceLine(choice.prose.price)}.`
		: `${choice.provider}; ${choice.prose.model} writes and ${choice.fast.model} keeps count.`;
}
