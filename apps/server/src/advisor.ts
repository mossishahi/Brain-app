/**
 * LLM deployment doctor: when a readiness check fails and a verified model
 * connection exists, the failure (message + technical detail + host facts)
 * is handed to the configured LLM for concrete fix guidance. Anthropic runs
 * with adaptive thinking; the Claude Agent SDK runs at max effort — both per
 * deployment policy, no tools, one bounded request. Advice is cached per
 * failure signature so repeated red icons never repeat the spend.
 */
import process from "node:process";

import {
  textContent,
  userMessage,
} from "@brainstorm-agentic/core";
import { ClaudeAgentExecutor } from "@brainstorm-agentic/executor-claude-agent";
import { AnthropicMessagesProvider } from "@brainstorm-agentic/provider-anthropic";

import type { ReadinessAdviceRequest, ReadinessAdvisor } from "./readiness.js";
import type { SettingsStore } from "./settings.js";

const ADVISOR_SYSTEM = [
  "You are the deployment doctor of the Brainstorm app: a Node.js research-pipeline server that",
  "users frequently launch on HPC login or compute nodes without root access or package managers,",
  "submitting work through SLURM. One of the server's environment readiness checks failed and the",
  "user needs the shortest path to a working environment.",
  "",
  "Reply in plain text, at most ~180 words, structured as:",
  "1. one-line diagnosis of the most likely cause;",
  "2. numbered fix steps with exact shell commands where applicable (bash on Linux, no sudo —",
  "   prefer user-space fixes: ~/opt installs, `module load`, venv/pip --user, environment",
  "   variables in the launch script);",
  "3. one fallback if the fix cannot work on this host.",
  "No markdown headings, no preamble, no questions back.",
].join("\n");

const ANTHROPIC_TIMEOUT_MS = 60_000;
const AGENT_SDK_TIMEOUT_MS = 120_000;
const MAX_DETAIL_CHARS = 4_000;

function advicePayload(request: ReadinessAdviceRequest): string {
  return JSON.stringify(
    {
      failedCheck: request.check,
      checkLabel: request.label,
      failure: request.message,
      ...(request.detail !== undefined
        ? {
            technicalDetail:
              request.detail.length > MAX_DETAIL_CHARS
                ? `${request.detail.slice(0, MAX_DETAIL_CHARS)}… (truncated)`
                : request.detail,
          }
        : {}),
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
    },
    null,
    2,
  );
}

export interface CreateReadinessAdvisorOptions {
  readonly settings: SettingsStore;
  readonly env?: NodeJS.ProcessEnv;
}

export function createReadinessAdvisor(
  options: CreateReadinessAdvisorOptions,
): ReadinessAdvisor {
  const cache = new Map<string, string>();
  return async (request) => {
    const settings = options.settings.get();
    const provider = settings.llm.provider;
    if (provider === "offline") return undefined;
    const key = [provider, request.check, request.message, request.detail ?? ""].join("\u0000");
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const payload = advicePayload(request);
    const contextLine = `Deployment context: runner=${settings.runner}, provider=${provider}.`;

    let advice: string | undefined;
    if (provider === "anthropic") {
      const apiKey = options.settings.getAnthropicApiKey();
      const model = settings.llm.model;
      if (!apiKey || !model) return undefined;
      const client = new AnthropicMessagesProvider({
        apiKey,
        model,
        ...(settings.llm.baseUrl !== undefined ? { baseURL: settings.llm.baseUrl } : {}),
        maxTokens: 1_200,
        // "Thinking mode" per deployment policy; adaptive lets the model
        // decide the depth for what is usually a short diagnosis.
        thinking: { type: "adaptive", display: "omitted" },
      });
      const response = await client.complete(
        {
          modelId: model,
          system: ADVISOR_SYSTEM,
          messages: [userMessage(`${contextLine}\n\n${payload}`)],
          maxOutputTokens: 1_200,
        },
        { signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS) },
      );
      advice = textContent(response.content).trim() || undefined;
    } else {
      const token = options.settings.getClaudeSetupToken();
      if (!token) return undefined;
      const executor = new ClaudeAgentExecutor({
        token,
        ...(settings.llm.model ? { model: settings.llm.model } : {}),
        maxTurns: 4,
        effort: "max",
        thinking: "adaptive",
        ...(options.env ? { env: options.env } : {}),
      });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort("readiness advice timed out"),
        AGENT_SDK_TIMEOUT_MS,
      );
      timer.unref();
      try {
        const result = await executor.execute(
          {
            taskId: `readiness-advice-${Date.now()}`,
            kind: "readiness.advise",
            input: payload,
            modelRequest: {
              system: ADVISOR_SYSTEM,
              messages: [userMessage(`${contextLine}\n\n${payload}`)],
            },
          },
          {
            runId: "readiness",
            nodePath: `readiness/${request.check}`,
            signal: controller.signal,
          },
        );
        if (result.status === "ok" && typeof result.output === "string") {
          advice = result.output.trim() || undefined;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (advice !== undefined) cache.set(key, advice);
    return advice;
  };
}
