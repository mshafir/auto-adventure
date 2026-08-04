import { Text, useInput } from "ink";

/**
 * One line of typed text.
 *
 * The game has never needed this before — conversations are choice-only, which is
 * deliberate — so rather than take a dependency for one screen, here is the forty
 * lines it actually requires.
 *
 * Controlled: the value lives in the caller, so a brief survives the field being
 * unmounted and remounted as the launcher moves between screens.
 */
export interface TextFieldProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onSubmit: (value: string) => void;
	readonly onCancel?: () => void;
	readonly placeholder?: string;
	readonly maxLength?: number;
}

/** Long enough for a premise, short enough to stay one line in the prompt. */
const DEFAULT_MAX = 240;

export function TextField({
	value,
	onChange,
	onSubmit,
	onCancel,
	placeholder = "",
	maxLength = DEFAULT_MAX,
}: TextFieldProps) {
	useInput((input, key) => {
		if (key.return) {
			onSubmit(value);
			return;
		}
		if (key.escape) {
			onCancel?.();
			return;
		}
		if (key.backspace || key.delete) {
			onChange(value.slice(0, -1));
			return;
		}
		// Arrows, tab and anything with a modifier are navigation, not text. Without
		// this, pressing up would insert the raw escape sequence into the brief.
		if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
		if (key.ctrl || key.meta) return;
		// `input` can carry several characters at once when the terminal delivers a
		// paste, so it is appended rather than treated as one keypress. Control
		// characters are stripped: a pasted newline must not become a glyph.
		const typed = [...input].filter(isPrintable).join("");
		if (!typed) return;
		onChange((value + typed).slice(0, maxLength));
	});

	const showing = value.length > 0 ? value : placeholder;
	return (
		<Text>
			<Text color="cyan">{"> "}</Text>
			<Text dimColor={value.length === 0}>{showing}</Text>
			{value.length > 0 ? <Text inverse> </Text> : null}
		</Text>
	);
}

/** Everything except the C0 control range and DEL. */
function isPrintable(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return code >= 0x20 && code !== 0x7f;
}
