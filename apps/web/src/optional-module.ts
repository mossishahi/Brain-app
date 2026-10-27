const localFailures = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Optional features own their fallback and must not trigger a whole-app reload.
 * Vite emits preloadError before this promise rejects, so the global recovery
 * handler waits one task before checking the original error's identity.
 */
export function loadOptionalModule<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    if (isObject(error)) localFailures.add(error);
    throw error;
  });
}

export function isOptionalModuleFailure(error: unknown): boolean {
  return isObject(error) && localFailures.has(error);
}
