import { useInput } from "ink";
import type { Command } from "../../core/rules/commands.js";
import { useGameSelector } from "../store.js";

export interface InputHandlers {
	readonly dispatch: (command: Command) => void;
	readonly onToggleTab: (tab: "map" | "world" | "inventory" | "quests" | "journal") => void;
}

/**
 * All key handling in one place.
 *
 * The previous version had two independent `useInput` registrations — the main
 * table and a second one inside the side panel — so the panel's tab keys fired
 * during dialogue, with no guard. Keeping every binding here means the modal
 * state is checked exactly once.
 */
export function useGameInput({ dispatch, onToggleTab }: InputHandlers): void {
	const inDialogue = useGameSelector((state) => state.dialogue !== undefined);

	useInput((input, key) => {
		if (inDialogue) {
			if (key.escape) return dispatch({ t: "CloseDialogue" });
			if (key.upArrow) return dispatch({ t: "ChoiceUp" });
			if (key.downArrow) return dispatch({ t: "ChoiceDown" });
			if (key.return || input === " ") return dispatch({ t: "Advance" });
			return;
		}

		if (key.upArrow) return dispatch({ t: "Move", facing: "up" });
		if (key.downArrow) return dispatch({ t: "Move", facing: "down" });
		if (key.leftArrow) return dispatch({ t: "Move", facing: "left" });
		if (key.rightArrow) return dispatch({ t: "Move", facing: "right" });
		if (input === " " || key.return) return dispatch({ t: "Interact" });

		switch (input.toLowerCase()) {
			case "m":
				return onToggleTab("map");
			case "w":
				return onToggleTab("world");
			case "i":
				return onToggleTab("inventory");
			case "q":
				return onToggleTab("quests");
			case "j":
				return onToggleTab("journal");
		}
	});
}
