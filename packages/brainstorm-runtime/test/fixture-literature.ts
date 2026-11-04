import { literatureActivities, type LiteratureActivityDeps } from "../src/literature-activities.js";

/** Offline workflow fixtures explicitly select their deterministic test encoder. */
export function hashLiteratureActivities(deps: LiteratureActivityDeps): ReturnType<typeof literatureActivities> {
  const activities = literatureActivities(deps);
  for (const name of ["literature.retrieve", "panel.compose"]) {
    const activity = activities[name]!;
    activities[name] = (input, context) => {
      const config = input.config !== null && typeof input.config === "object" && !Array.isArray(input.config)
        ? input.config
        : {};
      return activity({ ...input, config: { ...config, encoder: "hash-ngram-v1" } }, context);
    };
  }
  return activities;
}
