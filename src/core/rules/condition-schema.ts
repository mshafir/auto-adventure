import { z } from "zod";
import type { Condition } from "./condition.js";

/**
 * Validation for a condition an author wrote.
 *
 * Split from `condition.ts` the way `core/content/schema.ts` is split from
 * `pack.ts`: the evaluator is a pure function over a closed set of shapes and is
 * worth being able to test and reason about without zod anywhere near it, while
 * the parsing lives out here where a scenario file is read.
 *
 * Recursive, so it needs `z.lazy`, and recursion needs a depth limit — a
 * hand-written or hostile file can nest `not` ten thousand deep and take the
 * stack out inside `evaluate` long after parsing said the shape was fine. The
 * limit is applied as a refinement on the parsed value rather than by unrolling
 * the schema, because unrolling produces error messages nobody can read.
 */

const flagValue = z.union([z.string().max(120), z.number(), z.boolean()]);

const name = z.string().min(1).max(120);

/**
 * How deep a condition may nest.
 *
 * Eight is far past anything legible — a condition an author cannot read is a
 * condition they cannot debug — and far short of anything that troubles the
 * stack.
 */
const MAX_DEPTH = 8;

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
	z
		.union([
			z.object({ all: z.array(ConditionSchema).max(16) }),
			z.object({ any: z.array(ConditionSchema).max(16) }),
			z.object({ not: ConditionSchema }),
			z.object({ flag: name, equals: flagValue.optional() }),
			z.object({ item: name, atLeast: z.number().int().min(1).optional() }),
			z.object({ quest: name, is: z.enum(["open", "done", "absent"]) }),
			z.object({ talked: name }),
			z.object({ visited: name }),
			z.object({
				reputation: name,
				atLeast: z.number().int().min(-100).max(100).optional(),
				atMost: z.number().int().min(-100).max(100).optional(),
			}),
			z.object({
				disposition: name,
				atLeast: z.number().int().min(-100).max(100).optional(),
				atMost: z.number().int().min(-100).max(100).optional(),
			}),
			z.object({
				hour: z.object({
					from: z.number().int().min(0).max(23),
					to: z.number().int().min(0).max(23),
				}),
			}),
		])
		.refine((value) => depthOf(value as Condition) <= MAX_DEPTH, {
			message: `a condition may not nest more than ${MAX_DEPTH} deep`,
		}),
) as z.ZodType<Condition>;

function depthOf(condition: Condition): number {
	if ("all" in condition) return 1 + max(condition.all.map(depthOf));
	if ("any" in condition) return 1 + max(condition.any.map(depthOf));
	if ("not" in condition) return 1 + depthOf(condition.not);
	return 1;
}

function max(values: readonly number[]): number {
	let best = 0;
	for (const value of values) if (value > best) best = value;
	return best;
}

/**
 * A `requires` field, in either spelling.
 *
 * Both are accepted everywhere one appears, because the list form is genuinely
 * better for the commonest case — three flags that must all be set — and every
 * artifact already on disk is written that way.
 */
export const RequiresSchema = z.union([z.array(name).max(16), ConditionSchema]);
