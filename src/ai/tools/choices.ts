import { tool } from "ai";
import z from "zod";
import { useGameStore } from "../../store/game-store.js";

export const choices = tool({
	description: "Offer the user a set of choices to pick one from",
	parameters: z.object({
		choices: z.array(z.string()).describe("The choices to offer the user"),
	}),
	execute: async ({ choices }) => {
		const state = useGameStore.getState();
		return {
			interactionState: {
				...state.interactionState,
				choices,
				currentChoiceIndex: 0,
			},
		};
	},
});
