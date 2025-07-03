import { google } from "@ai-sdk/google";
import { GoogleGenAI } from "@google/genai";
import { generateObject } from "ai";
import type z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { env } from "../env.js";
import { log } from "../utils/log.js";

export async function objectGen<T>(
	prompt: string,
	schema: z.ZodSchema<T>,
): Promise<T> {
	const result = await generateObject({
		model: google("gemini-2.5-flash-preview-04-17"),
		temperature: 1,
		prompt,
		schema,
	});
	log("Usage: ", result.usage);
	return result.object;
}

export async function objectGenGoogle<T>(
	prompt: string,
	schema: z.ZodSchema<T>,
) {
	const genai = new GoogleGenAI({ apiKey: env.googleApiKey });
	const response = await genai.models.generateContent({
		model: "gemini-2.5-flash",
		contents: prompt,
		config: {
			responseMimeType: "application/json",
			responseJsonSchema: zodToJsonSchema(schema, {
				$refStrategy: "none",
				removeAdditionalStrategy: "strict",
			}),
		},
	});
	const result = JSON.parse(response.text ?? "{}") as T;
	log(`Generated result for prompt`, response.usageMetadata);
	return result;
}
