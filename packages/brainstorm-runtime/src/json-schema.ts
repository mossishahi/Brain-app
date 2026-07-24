import type { JsonObject } from "@brainstorm-agentic/core";
import { z } from "zod";

import { BrainstormRuntimeError } from "./errors.js";

/**
 * Converts the shipped Zod artifact contracts to provider-neutral JSON Schema
 * using Zod 4's native converter. Non-representable runtime refinements
 * (paragraph counts, cross-field checks) stay enforced by Zod validation after
 * execution; the representable structural constraints are sent to the model.
 */
export function artifactSchemaToJsonSchema(schema: unknown, name: string): JsonObject {
  try {
    const converted = z.toJSONSchema(schema as z.ZodType, {
      target: "draft-2020-12",
      io: "output",
      unrepresentable: "any",
    }) as JsonObject;
    const { $schema: _ignored, ...rest } = converted;
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: name,
      ...rest,
    };
  } catch (error) {
    throw new BrainstormRuntimeError(
      `artifact schema "${name}" cannot be converted to JSON Schema`,
      "SCHEMA_CONVERSION_ERROR",
      { cause: error },
    );
  }
}
