import { tool } from "ai";
import z from "zod";
import { useGameStore } from "../../store/game-store.js";

export const endInteractionTool = tool({
	description: "Forcibly end the interaction with the user",
	parameters: z.object({}),
	execute: async () => {
		useGameStore.setState((state) => {
			return {
				interactionState: undefined,
			};
		});
	},
});
