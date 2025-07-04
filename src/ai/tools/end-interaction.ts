import { tool } from "ai";
import z from "zod";

export const choices = tool({
	description: "End the interaction with the user",
	parameters: z.object({}),
	execute: async () => {
		return {
			interactionState: undefined,
		};
	},
});
