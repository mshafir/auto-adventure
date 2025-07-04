import { objectInteractGen } from "../../ai/object-interact-gen.js";
import { textGenWithTools } from "../../ai/text-gen.js";
import { choices } from "../../ai/tools/choices.js";
import {
	addInventoryItem,
	removeInventoryItem,
} from "../../ai/tools/inventory.js";
import {
	addQuestProgress,
	completeQuest,
	createQuest,
	removeQuest,
} from "../../ai/tools/quests.js";
import { getTile } from "../../utils/get-tile.js";
import { type GameState, useGameStore } from "../game-store.js";
import { defineAction } from "./action.js";

export function getNearbyObject(state: GameState) {
	const {
		playerPosition: [x, y],
		map,
	} = state;
	const { objects, mapTiles } = map;

	// Check all 8 adjacent positions (including diagonals)
	const adjacentPositions: [number, number][] = [
		[x - 1, y - 1], // top-left
		[x, y - 1], // top
		[x + 1, y - 1], // top-right
		[x - 1, y], // left
		[x + 1, y], // right
		[x - 1, y + 1], // bottom-left
		[x, y + 1], // bottom
		[x + 1, y + 1], // bottom-right
	];

	for (const pos of adjacentPositions) {
		const symbol = getTile(mapTiles, pos);
		if (symbol && /[A-Z]/.test(symbol)) {
			const object = objects.find((obj) => obj.letter === symbol);
			if (object) {
				return object;
			}
		}
	}

	return null;
}

export function generateChatResponse(
	objectName: string,
	objectDescription: string,
): string {
	const responses = [
		`You approach the ${objectName.toLowerCase()}. ${objectDescription}`,
		`As you get closer to the ${objectName.toLowerCase()}, you notice its details more clearly. ${objectDescription}`,
		`The ${objectName.toLowerCase()} stands before you. ${objectDescription}`,
		`You examine the ${objectName.toLowerCase()} carefully. ${objectDescription}`,
		`Standing near the ${objectName.toLowerCase()}, you can see it clearly. ${objectDescription}`,
	];

	// Add some variety based on object type
	if (
		objectName.toLowerCase().includes("vendor") ||
		objectName.toLowerCase().includes("store")
	) {
		responses.push(
			"The merchant greets you warmly, ready to show their wares.",
		);
		responses.push(
			"You can see various goods displayed, and the shopkeeper looks up expectantly.",
		);
	} else if (objectName.toLowerCase().includes("fountain")) {
		responses.push("The water flows gently, creating a peaceful atmosphere.");
		responses.push(
			"You can hear the soothing sound of water as it cascades down.",
		);
	} else if (
		objectName.toLowerCase().includes("notice") ||
		objectName.toLowerCase().includes("board")
	) {
		responses.push("Various notices and quests are posted on the board.");
		responses.push(
			"You scan the board for any interesting information or opportunities.",
		);
	}

	return responses[Math.floor(Math.random() * responses.length)];
}

export const startOrContinueInteraction = defineAction(
	async (state: GameState) => {
		const nearbyObject = getNearbyObject(state);

		if (!nearbyObject) {
			return state;
		}

		let { interactionState } = state;

		if (!interactionState) {
			useGameStore.setState({
				interactionState: {
					currentMessageIndex: 0,
					currentObject: nearbyObject,
					chatMessages: [{ role: "user", content: "How do you respond?" }],
				},
			});
			return await objectInteractGen(useGameStore.getState(), nearbyObject);
		}

		let messageIdx = interactionState?.currentMessageIndex ?? 0;
		let messages = interactionState?.chatMessages ?? [];

		if (
			interactionState?.choices &&
			interactionState.currentChoiceIndex !== undefined
		) {
			const choice =
				interactionState.choices[interactionState.currentChoiceIndex];
			messageIdx = messageIdx + 1;
			messages = [...messages, { role: "user", content: choice }];
			interactionState = {
				...interactionState,
				choices: [],
				currentChoiceIndex: undefined,
				chatMessages: messages,
				currentMessageIndex: messageIdx,
			};
			useGameStore.setState({ interactionState });
		}

		if (messageIdx >= messages.length - 1) {
			return await objectInteractGen(
				{ ...state, interactionState },
				nearbyObject,
			);
		}

		return {
			interactionState: {
				...interactionState,
				currentMessageIndex: Math.min(
					interactionState.chatMessages.length - 1,
					messageIdx + 1,
				),
			},
		};
	},
);

export const endInteraction = defineAction((state: GameState) => {
	return {
		interactionState: undefined,
	};
});
