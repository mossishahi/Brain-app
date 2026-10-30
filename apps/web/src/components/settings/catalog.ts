/** Settings navigation is independent of the forms and their storage scopes. */
export const settingsCategories = [
  { id: "connections", label: "Models & connections", description: "Choose a provider and configure how models work." },
  { id: "stageModels", label: "Stage models", description: "Choose a model and reasoning settings for each stage of research." },
  { id: "research", label: "Research", description: "Set your review defaults and approval preferences." },
  { id: "tools", label: "Tools & sources", description: "Manage search, attachments, and execution capabilities." },
  { id: "execution", label: "Execution", description: "Configure where research tasks and GPU jobs run." },
  { id: "recovery", label: "Recovery", description: "Keep research moving after interruptions and credit limits." },
  { id: "updates", label: "App updates", description: "Check application updates and the connected Brain registry." },
  { id: "appearance", label: "Appearance", description: "Make this workspace your own." },
] as const;

export type SettingsCategory = (typeof settingsCategories)[number]["id"];
export type SettingsSectionId = "updates" | "execution" | "gpu" | "model" | "credential" | "confirmation" | "review" | "panel" | "panelComposition" | "tools" | "webSearch" | "availability" | "recovery";
export type SaveState = "idle" | "saving" | "saved" | "error";

export const categorySections: Record<SettingsCategory, readonly SettingsSectionId[]> = {
  connections: ["model", "credential"], stageModels: [], research: ["confirmation", "review", "panel", "panelComposition"],
  tools: ["tools", "webSearch", "availability"], execution: ["execution", "gpu"],
  recovery: ["recovery"], updates: ["updates"], appearance: [],
};

export function settingsCategory(value?: string): SettingsCategory {
  if (settingsCategories.some((category) => category.id === value)) return value as SettingsCategory;
  const aliases: Record<string, SettingsCategory> = {
    model: "connections", credential: "connections", webSearch: "tools", availability: "tools", gpu: "execution",
    confirmation: "research", review: "research", panel: "research", panelComposition: "research",
  };
  return aliases[value ?? ""] ?? "connections";
}
