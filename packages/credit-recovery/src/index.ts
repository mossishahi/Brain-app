export interface CreditResetResolution {
  readonly retryAt: number;
  readonly source: "deterministic" | "openrouter";
  readonly timeZone: string;
}

export interface ResolveCreditResetOptions {
  readonly message: string;
  readonly now?: Date;
  readonly timeZone?: string;
  readonly safetyBufferSeconds?: number;
  readonly openRouterApiKey?: string;
  readonly openRouterModel?: string;
  readonly fetchFn?: typeof fetch;
}

const MAX_RESET_DISTANCE_MS = 7 * 24 * 60 * 60 * 1000;

export function isCreditLimitMessage(message: string): boolean {
  return /session limit|usage limit|credit(?:s)? (?:exhausted|limit)|rate limit.*reset|resets?\s+(?:at\s+)?\d/i.test(
    message,
  );
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const represented = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    guess += target - represented;
  }
  return guess;
}

export function parseCreditResetDeterministically(
  message: string,
  now = new Date(),
  fallbackTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): CreditResetResolution | undefined {
  const relative = /resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(
    message,
  );
  if (relative && (relative[1] || relative[2])) {
    const duration =
      Number(relative[1] ?? 0) * 60 * 60 * 1000 +
      Number(relative[2] ?? 0) * 60 * 1000;
    return {
      retryAt: now.getTime() + duration,
      source: "deterministic",
      timeZone: fallbackTimeZone,
    };
  }

  const iso = /resets?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}T[^\s]+)/i.exec(message);
  if (iso) {
    const retryAt = Date.parse(iso[1]!);
    if (Number.isFinite(retryAt)) {
      return {
        retryAt,
        source: "deterministic",
        timeZone: fallbackTimeZone,
      };
    }
  }

  const clock = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
    message,
  );
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return undefined;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const timeZone = clock[4] ?? fallbackTimeZone;
  let parts: Record<string, number>;
  try {
    parts = zonedParts(now, timeZone);
  } catch {
    return undefined;
  }
  let retryAt = zonedLocalToUtc(
    parts.year!,
    parts.month!,
    parts.day!,
    hour,
    minute,
    timeZone,
  );
  if (retryAt <= now.getTime() + 1000) {
    const tomorrow = new Date(
      Date.UTC(parts.year!, parts.month! - 1, parts.day! + 1),
    );
    retryAt = zonedLocalToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return { retryAt, source: "deterministic", timeZone };
}

async function resolveWithOpenRouter(
  options: ResolveCreditResetOptions,
  now: Date,
  timeZone: string,
): Promise<CreditResetResolution> {
  const response = await (options.fetchFn ?? fetch)(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.openRouterApiKey}`,
        "content-type": "application/json",
        "x-title": "Brainstorm Agentic Credit Recovery",
      },
      body: JSON.stringify({
        model: options.openRouterModel ?? "openrouter/free",
        messages: [
          {
            role: "system",
            content:
              "Extract the exact future restart timestamp from a provider limit message. Use the supplied current time and IANA timezone. Return only the JSON schema.",
          },
          {
            role: "user",
            content: JSON.stringify({
              errorMessage: options.message,
              currentTime: now.toISOString(),
              systemTimeZone: timeZone,
            }),
          },
        ],
        temperature: 0,
        max_tokens: 80,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "credit_reset",
            strict: true,
            schema: {
              type: "object",
              properties: {
                retryAt: { type: "string" },
                timeZone: { type: "string" },
              },
              required: ["retryAt", "timeZone"],
              additionalProperties: false,
            },
          },
        },
        provider: { require_parameters: true },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`OpenRouter reset parser HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter reset parser returned no content");
  const parsed = JSON.parse(content) as { retryAt?: string; timeZone?: string };
  const retryAt = Date.parse(parsed.retryAt ?? "");
  if (
    !Number.isFinite(retryAt) ||
    retryAt <= now.getTime() ||
    retryAt - now.getTime() > MAX_RESET_DISTANCE_MS
  ) {
    throw new Error("OpenRouter returned an unsafe reset timestamp");
  }
  return {
    retryAt,
    source: "openrouter",
    timeZone: parsed.timeZone || timeZone,
  };
}

export async function resolveCreditReset(
  options: ResolveCreditResetOptions,
): Promise<CreditResetResolution> {
  const now = options.now ?? new Date();
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const deterministic = parseCreditResetDeterministically(
    options.message,
    now,
    timeZone,
  );
  const resolution =
    deterministic ??
    (options.openRouterApiKey
      ? await resolveWithOpenRouter(options, now, timeZone)
      : undefined);
  if (!resolution) {
    throw new Error(
      "Could not determine provider credit reset time; configure an OpenRouter API key or resume manually",
    );
  }
  const safetyBuffer = Math.max(0, options.safetyBufferSeconds ?? 60) * 1000;
  return { ...resolution, retryAt: resolution.retryAt + safetyBuffer };
}

