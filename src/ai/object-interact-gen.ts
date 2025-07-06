import {
	type GameState,
	type InteractionState,
	useGameStore,
} from "../store/game-store.js";
import {
	addMessage,
	incrementMessageIndex,
} from "../store/utils/interaction-utils.js";
import { log } from "../utils/log.js";
import { textGenWithTools } from "./text-gen.js";
import { choices } from "./tools/choices.js";
import { endInteractionTool } from "./tools/end-interaction.js";
import { addInventoryItem, removeInventoryItem } from "./tools/inventory.js";
import {
	addQuestProgress,
	completeQuest,
	createQuest,
	removeQuest,
} from "./tools/quests.js";

export async function objectInteractGen(): Promise<Partial<GameState>> {
	const state = useGameStore.getState();
	const currentObject = state.interactionState?.currentObject;
	if (!currentObject) {
		log("No current object");
		return state;
	}
	const messages = [...(state.interactionState?.chatMessages ?? [])];
	const lastMessage = messages[messages.length - 1];
	try {
		const chatResponse = await textGenWithTools(
			[
				{
					role: "system",
					content: `You are an object or character in an RPG game. You are ${currentObject.name}: ${currentObject.description}.
You are in a location ${state.map.name} with description "${state.map.description}.

The player has chosen to interact with you. 
The player has these items in their inventory: ${JSON.stringify(state.inventory)}.
The player has these quests in their quest list: ${JSON.stringify(state.quests.filter((q) => !q.completed))}.

You can write messages to the player, ask multiple choice questions, or perform other actions.`,
				},
				...messages.map((msg) => ({
					role: msg.role,
					content:
						msg.role === "user"
							? `I chose '${msg.content}'. How do you respond?`
							: msg.content,
				})),
				...(lastMessage?.role === "assistant"
					? [
							{
								role: "user" as const,
								content: "Please continue",
							},
						]
					: []),
			],
			{
				choices,
				addInventoryItem,
				removeInventoryItem,
				createQuest,
				addQuestProgress,
				completeQuest,
				removeQuest,
				endInteractionTool,
			},
		);

		for (const response of chatResponse) {
			if (response.role === "assistant") {
				if (Array.isArray(response.content)) {
					for (const part of response.content) {
						if (part.type === "text") {
							useGameStore.setState((state) => addMessage(state, part.text));
						}
					}
				}
			}
		}

		useGameStore.setState((state) => incrementMessageIndex(state));
		return useGameStore.getState();
	} catch (e) {
		log(`Error in objectInteractGen: ${e}`);
		return state;
	}
}
