import { tool } from "ai";
import { z } from "zod";
import { useGameStore } from "../../store/game-store.js";
import { addMessage } from "../../store/utils/interaction-utils.js";
import { log } from "../../utils/log.js";

export const createQuest = tool({
	description: "Create a new quest and add it to the quest log",
	parameters: z.object({
		name: z.string().describe("The name of the quest"),
		description: z.string().describe("The description of the quest"),
		initialProgress: z
			.array(z.string())
			.optional()
			.describe("Initial progress steps for the quest"),
	}),
	execute: async ({ name, description, initialProgress = [] }) => {
		useGameStore.setState((state) => {
			const existingQuest = state.quests.find((quest) => quest.name === name);

			if (existingQuest) {
				log(`Quest "${name}" already exists in the quest log`);
				return state;
			}

			return {
				quests: [
					...state.quests,
					{
						name,
						description,
						progress: initialProgress,
						completed: false,
					},
				],
				...addMessage(state, `You have embarked on quest ${name}.`),
			};
		});
	},
});

export const addQuestProgress = tool({
	description: "Add progress to an existing quest",
	parameters: z.object({
		questName: z.string().describe("The name of the quest to update"),
		progressStep: z.string().describe("The progress step to add to the quest"),
	}),
	execute: async ({ questName, progressStep }) => {
		useGameStore.setState((state) => {
			const questIndex = state.quests.findIndex(
				(quest) => quest.name === questName,
			);

			if (questIndex === -1) {
				log(`Quest "${questName}" not found in the quest log`);
				return state;
			}

			const quest = state.quests[questIndex];
			if (quest.completed) {
				log(`Quest "${questName}" is already completed`);
				return state;
			}

			return {
				quests: state.quests.map((quest, index) =>
					index === questIndex
						? { ...quest, progress: [...quest.progress, progressStep] }
						: quest,
				),
				...addMessage(state, `You have made progress on quest ${questName}.`),
			};
		});
	},
});

export const completeQuest = tool({
	description: "Mark a quest as completed",
	parameters: z.object({
		questName: z.string().describe("The name of the quest to complete"),
	}),
	execute: async ({ questName }) => {
		useGameStore.setState((state) => {
			const questIndex = state.quests.findIndex(
				(quest) => quest.name === questName,
			);

			if (questIndex === -1) {
				log(`Quest "${questName}" not found in the quest log`);
				return {};
			}

			const quest = state.quests[questIndex];
			if (quest.completed) {
				log(`Quest "${questName}" is already completed`);
				return {};
			}

			return {
				quests: state.quests.map((quest, index) =>
					index === questIndex ? { ...quest, completed: true } : quest,
				),
				...addMessage(state, `You have completed quest ${questName}.`),
			};
		});
	},
});

export const removeQuest = tool({
	description: "Remove a quest from the quest log",
	parameters: z.object({
		questName: z.string().describe("The name of the quest to remove"),
	}),
	execute: async ({ questName }) => {
		useGameStore.setState((state) => {
			const questIndex = state.quests.findIndex(
				(quest) => quest.name === questName,
			);

			if (questIndex === -1) {
				log(`Quest "${questName}" not found in the quest log`);
				return {};
			}

			return {
				quests: state.quests.filter((quest) => quest.name !== questName),
				...addMessage(state, `You have abandoned quest ${questName}.`),
			};
		});
	},
});
