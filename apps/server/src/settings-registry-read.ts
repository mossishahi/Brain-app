import { ContentRegistryClient } from "@brainstorm-agentic/registry-client";

export interface SettingsRegistryReader {
  resolvePin(bundle: string, version?: string): Promise<{ readonly version: string }>;
  readText(path: string): Promise<string>;
  close(): Promise<void>;
}

export interface SettingsRegistryReadOptions {
  readonly timeoutMs?: number;
  readonly createClient?: (url: string) => SettingsRegistryReader;
}

/** Bound the complete metadata read, including multi-hop registry requests. */
export async function readSettingsRegistry<T>(
  url: string,
  read: (client: Omit<SettingsRegistryReader, "close">) => Promise<T>,
  options: SettingsRegistryReadOptions = {},
): Promise<T> {
  const client = options.createClient?.(url) ?? new ContentRegistryClient(url);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = async <V>(operation: () => Promise<V>): Promise<V> => {
    controller.signal.throwIfAborted();
    const result = await operation();
    controller.signal.throwIfAborted();
    return result;
  };
  try {
    // The caller commits its cache only after this await. A late registry
    // response can neither replace newer data nor start another request.
    return await Promise.race([
      read({
        resolvePin: (bundle, version) => guard(() => client.resolvePin(bundle, version)),
        readText: path => guard(() => client.readText(path)),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Settings metadata discovery timed out");
          controller.abort(error);
          reject(error);
        }, options.timeoutMs ?? 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    // An unavailable transport's cleanup must not extend the read deadline.
    void client.close().catch(() => undefined);
  }
}
