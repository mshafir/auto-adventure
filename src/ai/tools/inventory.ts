import { tool } from "ai";
import { z } from "zod";
import { useGameStore } from "../../store/game-store.js";
import { addMessage, hasMessage } from "../../store/utils/interaction-utils.js";

export const addInventoryItem = tool({
	description: "Add an item to the inventory",
	parameters: z.object({
		itemName: z.string().describe("The item to add to the inventory"),
		itemDescription: z.string().describe("The description of the item"),
		quantity: z.number().describe("The quantity of the item"),
	}),
	execute: async ({ itemName, itemDescription, quantity }) => {
		useGameStore.setState((state) => {
			const existingItem = state.inventory.find(
				(item) => item.name === itemName,
			);
			let targetQuantity = quantity;
			let inventory = state.inventory;
			if (existingItem) {
				targetQuantity = existingItem.quantity + quantity;
				inventory = inventory.map((item) =>
					item.name === itemName ? { ...item, quantity: targetQuantity } : item,
				);
			} else {
				inventory = [
					...inventory,
					{
						name: itemName,
						description: itemDescription,
						quantity: targetQuantity,
					},
				];
			}
			const message = `You have added ${quantity} ${itemName} to your inventory.`;
			if (hasMessage(state, message)) {
				return {};
			}
			return {
				inventory,
				...addMessage(state, message),
			};
		});
	},
});

export const removeInventoryItem = tool({
	description: "Remove an item from the inventory",
	parameters: z.object({
		itemName: z.string().describe("The item to remove from the inventory"),
		quantity: z.number().describe("The quantity of the item"),
	}),
	execute: async ({ itemName, quantity }) => {
		useGameStore.setState((state) => {
			const inventory = state.inventory;
			const existingItemIndex = inventory.findIndex(
				(item) => item.name === itemName,
			);
			if (existingItemIndex !== -1) {
				const targetQuantity = Math.max(
					inventory[existingItemIndex].quantity - quantity,
					0,
				);
				const message = `You have lost ${quantity} ${itemName} from your inventory.`;
				if (hasMessage(state, message)) {
					return {};
				}
				return {
					...addMessage(state, message),
					inventory: inventory
						.map((item, index) =>
							index === existingItemIndex
								? { ...item, quantity: targetQuantity }
								: item,
						)
						.filter((item) => item.name === "Gold" || item.quantity > 0),
				};
			}
			return {};
		});
	},
});
