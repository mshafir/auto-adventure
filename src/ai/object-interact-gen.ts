import type { GameState, InteractionState } from "../store/game-store.js";
import { textGenWithTools } from "./text-gen.js";
import { choices } from "./tools/choices.js";
import { addInventoryItem, removeInventoryItem } from "./tools/inventory.js";
import {
	addQuestProgress,
	completeQuest,
	createQuest,
	removeQuest,
} from "./tools/quests.js";

export async function objectInteractGen(
	state: GameState,
	currentObject: InteractionState["currentObject"],
): Promise<Partial<GameState>> {
	const messages = [...(state.interactionState?.chatMessages ?? [])];
	const lastMessage = messages[messages.length - 1];
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
		},
	);

	let result = state;
	const newMessages = [];

	for (const response of chatResponse) {
		if (response.role === "assistant") {
			if (Array.isArray(response.content)) {
				for (const part of response.content) {
					if (part.type === "text") {
						newMessages.push({
							role: "assistant" as const,
							content: part.text,
						});
					}
				}
			}
		}
		if (response.role === "tool") {
			const toolCall = response.content[0];
			if (toolCall.type === "tool-result") {
				result = { ...result, ...(toolCall.result as any) };
			}
		}
	}

	if (result.interactionState) {
		const chatMessages = [
			...(result.interactionState.chatMessages ?? []),
			...newMessages,
		];
		result.interactionState = {
			...result.interactionState,
			chatMessages,
			currentMessageIndex: Math.min(
				chatMessages.length - 1,
				(result.interactionState.currentMessageIndex ?? 0) + 1,
			),
		};
	}

	return result;
}
