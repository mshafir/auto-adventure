import { useInput } from "ink";
import type { Command } from "../../core/rules/commands.js";
import type { HudAction, HudState } from "../hud-state.js";
import { useGameSelector } from "../store.js";
import { routeKey } from "./route-key.js";

export interface InputHandlers {
	readonly dispatch: (command: Command) => void;
	readonly hud: HudState;
	readonly hudDispatch: (action: HudAction) => void;
	/** How long the focused pane's list is, so the cursor cannot run off it. */
	readonly listCount: number;
	/** Whether the map is drawn in pixels, and so whether zoom means anything. */
	readonly canZoom: boolean;
	/** Ask to drop whatever the inventory cursor is on. Absent when it cannot. */
	readonly onDrop?: () => void;
	/** Save and leave. Called only once the confirmation has been answered. */
	readonly onQuit: () => void;
}

/**
 * All key handling in one place.
 *
 * An earlier version had two independent `useInput` registrations — the main
 * table and a second one inside the side panel — so the panel's tab keys fired
 * during dialogue, with no guard. Keeping every binding here means the modal
 * state is checked exactly once. The decision itself lives in `routeKey`, which
 * is pure; this is only the wiring.
 */
export function useGameInput({
	dispatch,
	hud,
	hudDispatch,
	listCount,
	canZoom,
	onDrop,
	onQuit,
}: InputHandlers): void {
	const inDialogue = useGameSelector((state) => state.dialogue !== undefined);
	const onCard = useGameSelector((state) => state.card !== undefined);
	const inScene = useGameSelector((state) => state.scene !== undefined);

	useInput((input, key) => {
		const routed = routeKey(input, key, {
			inDialogue,
			onCard,
			inScene,
			hud,
			listCount,
			canDrop: onDrop !== undefined,
			canZoom,
		});
		if (!routed) return;
		// Answering a question always takes the question down, whichever way it was
		// answered; `routeKey` says what the answer meant, not what to do with the
		// prompt.
		if (hud.confirm) hudDispatch({ t: "Dismiss" });

		switch (routed.t) {
			case "command":
				return dispatch(routed.command);
			case "hud":
				return hudDispatch(routed.action);
			case "askDrop":
				return onDrop?.();
			case "quit":
				return onQuit();
		}
	});
}
