import { WorkflowConfigError, type JsonObject, type JsonValue } from "@brainstorm-agentic/core";

import { BrainstormRuntimeError } from "./errors.js";

interface ClassifierOptions {
  readonly routeKeyTerms: boolean;
  readonly scoreEquivalents: boolean;
}

const has = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Bindings identify the new contract; old pinned workflows keep their old output requirements. */
function options(bindings: JsonObject): ClassifierOptions | undefined {
  if (!has(bindings, "routeKeyTerms") && !has(bindings, "equivalentProblemWeight")) return undefined;
  if (typeof bindings.routeKeyTerms !== "boolean" ||
      typeof bindings.equivalentProblemWeight !== "number" ||
      !Number.isFinite(bindings.equivalentProblemWeight) || bindings.equivalentProblemWeight < 0) {
    throw new WorkflowConfigError("classifier requires routeKeyTerms (boolean) and equivalentProblemWeight (finite nonnegative number)");
  }
  return { routeKeyTerms: bindings.routeKeyTerms, scoreEquivalents: bindings.equivalentProblemWeight > 0 };
}

function properties(schema: JsonObject): Record<string, JsonValue> {
  if (!record(schema.properties)) throw new WorkflowConfigError("classifier artifact schema must declare object properties");
  return schema.properties as Record<string, JsonValue>;
}

function child(schema: JsonObject, name: string): JsonObject {
  const value = properties(schema)[name];
  if (!record(value)) throw new WorkflowConfigError(`classifier artifact schema must declare ${name}`);
  return value;
}

function items(schema: JsonObject): JsonObject {
  if (!record(schema.items)) throw new WorkflowConfigError("classifier artifact schema must declare array items");
  return schema.items;
}

function required(schema: JsonObject, name: string): void {
  child(schema, name);
  const fields = Array.isArray(schema.required) ? schema.required : [];
  (schema as Record<string, JsonValue>).required = fields.includes(name) ? fields : [...fields, name];
}

function remove(schema: JsonObject, name: string): void {
  delete properties(schema)[name];
  if (Array.isArray(schema.required)) {
    (schema as Record<string, JsonValue>).required = schema.required.filter((entry) => entry !== name);
  }
}

/** Only ask the provider to produce fields consumed by this run's configuration. */
export function classifierTaskSchema(schema: JsonObject, bindings: JsonObject): JsonObject {
  const configuration = options(bindings);
  const result = structuredClone(schema);
  const embedding = child(result, "embeddingInput");
  const equivalent = items(child(embedding, "equivalentProblems"));
  if (configuration === undefined) {
    // The persisted artifact accepts both generations; pinned old tasks retain their stricter contract.
    required(result, "cotSteps");
    required(equivalent, "field");
    required(equivalent, "confidence");
    return result;
  }
  remove(result, "cotSteps");
  remove(items(child(embedding, "facets")), "kind");
  remove(equivalent, "field");
  if (configuration.scoreEquivalents) required(equivalent, "confidence");
  else remove(equivalent, "confidence");
  if (configuration.routeKeyTerms) required(embedding, "keyTerms");
  else remove(embedding, "keyTerms");
  return result;
}

/** Re-check the dynamic contract on write, including providers/executors that ignore JSON Schema. */
export function assertClassifierOutput(output: JsonValue, bindings: JsonObject): void {
  const configuration = options(bindings);
  const fail = (message: string): never => {
    throw new BrainstormRuntimeError(`classifier output ${message}`, "CLASSIFIER_CONTRACT_MISMATCH");
  };
  if (!record(output) || !record(output.embeddingInput)) fail("must contain embeddingInput");
  const classification = output as JsonObject;
  const embedding = classification.embeddingInput as JsonObject;
  if (configuration === undefined) {
    if (!has(classification, "cotSteps")) fail("must include cotSteps for this pinned workflow");
  } else {
    if (has(classification, "cotSteps")) fail("must not choose cotSteps; argument steps come from user settings");
    if (configuration.routeKeyTerms !== has(embedding, "keyTerms")) {
      fail(configuration.routeKeyTerms ? "must include keyTerms because its retrieval route is enabled" : "must omit keyTerms because its retrieval route is disabled");
    }
    for (const facet of Array.isArray(embedding.facets) ? embedding.facets : []) {
      if (record(facet) && has(facet, "kind")) fail("must not include unused facet.kind labels");
    }
  }
  for (const equivalent of Array.isArray(embedding.equivalentProblems) ? embedding.equivalentProblems : []) {
    if (!record(equivalent)) continue; // The artifact schema reports structural errors.
    if (configuration === undefined) {
      if (!has(equivalent, "field") || !has(equivalent, "confidence")) fail("must include equivalent field and confidence for this pinned workflow");
    } else {
      if (has(equivalent, "field")) fail("must not include unused equivalent.field labels");
      if (configuration.scoreEquivalents !== has(equivalent, "confidence")) {
        fail(configuration.scoreEquivalents ? "must include equivalent confidence when equivalents contribute to scoring" : "must omit equivalent confidence when equivalents do not contribute to scoring");
      }
    }
  }
}

/** A configured run always owns its count, even if supplied a legacy classification artifact. */
export function classificationArgumentSteps(input: JsonObject, classification: JsonObject): number {
  const value = has(input, "argumentSteps") ? input.argumentSteps : classification.cotSteps;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 3 || value > 9) {
    throw new BrainstormRuntimeError(
      "classification.apply requires argumentSteps from user settings (an integer from 3 to 9), or cotSteps for a legacy workflow",
      "INVALID_ARGUMENT_STEPS",
    );
  }
  return value;
}
