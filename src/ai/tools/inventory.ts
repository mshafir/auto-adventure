import { tool } from "ai";
import { z } from "zod";
import { type GameState, useGameStore } from "../../store/game-store.js";
import { log } from "../../utils/log.js";

export function addMessage(message: string): Partial<GameState> {
	const state = useGameStore.getState();
	if (!state.interactionState) return state;
	return {
		interactionState: {
			...state.interactionState,
			chatMessages: [
				...(state.interactionState?.chatMessages ?? []),
				{ role: "assistant", content: message },
			],
		},
	};
}

export const addInventoryItem = tool({
	description: "Add an item to the inventory",
	parameters: z.object({
		itemName: z.string().describe("The item to add to the inventory"),
		itemDescription: z.string().describe("The description of the item"),
		quantity: z.number().describe("The quantity of the item"),
	}),
	execute: async ({ itemName, itemDescription, quantity }) => {
		const state = useGameStore.getState();
		const existingItem = state.inventory.find((item) => item.name === itemName);
		let targetQuantity = quantity;
		if (existingItem) {
			targetQuantity = existingItem.quantity + quantity;
		}
		return {
			inventory: [
				...state.inventory,
				{
					name: itemName,
					description: itemDescription,
					quantity: targetQuantity,
				},
			],
			...addMessage(
				`You have added ${quantity} ${itemName} to your inventory.`,
			),
		};
	},
});

export const removeInventoryItem = tool({
	description: "Remove an item from the inventory",
	parameters: z.object({
		itemName: z.string().describe("The item to remove from the inventory"),
		quantity: z.number().describe("The quantity of the item"),
	}),
	execute: async ({ itemName, quantity }) => {
		const state = useGameStore.getState();
		const inventory = state.inventory;
		const existingItemIndex = inventory.findIndex(
			(item) => item.name === itemName,
		);
		if (existingItemIndex !== -1) {
			const targetQuantity = Math.max(
				inventory[existingItemIndex].quantity - quantity,
				0,
			);
			return {
				inventory: inventory.map((item, index) =>
					index === existingItemIndex
						? { ...item, quantity: targetQuantity }
						: item,
				),
				...addMessage(
					`You have lost ${quantity} ${itemName} to your inventory.`,
				),
			};
		}
		log(`Item ${itemName} not found in the inventory`);
		return {};
	},
});
