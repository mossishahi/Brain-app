import {
  SLURM_COMMAND_TAG,
  type ServerSettings,
} from "@brainstorm-agentic/protocol";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export interface OrchestrationCommandOptions {
  readonly workerPath: string;
  readonly mode: "run" | "resume";
  readonly runId: string;
  readonly topic?: string;
  readonly sessionRoot: string;
  readonly eventsFile: string;
  readonly contentDir: string;
  readonly contentRegistryUrl?: string;
  readonly contentRegistryVersion?: string;
  /** Manifest of the job's ingested attachments (run mode only). */
  readonly attachmentsManifest?: string;
  readonly settings: ServerSettings;
  readonly gate?: {
    readonly gateKey: string;
    readonly action: "approve" | "shrink";
    readonly members?: readonly string[];
  };
}

function modelEnvironment(settings: ServerSettings): string[] {
  if (settings.llm.provider === "offline") return [];
  const entries: string[] = [
    `BRAINSTORM_AGENTIC_PROVIDER=${shellQuote(settings.llm.provider)}`,
  ];
  if (settings.llm.model) {
    entries.push(`BRAINSTORM_AGENTIC_MODEL=${shellQuote(settings.llm.model)}`);
  }
  for (const [route, model] of Object.entries(settings.llm.modelsByRoute ?? {})) {
    const name = `BRAINSTORM_AGENTIC_MODEL_${route.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
    entries.push(`${name}=${shellQuote(model)}`);
  }
  return entries;
}

export function buildOrchestrationCommand(
  options: OrchestrationCommandOptions,
): string {
  const args = [
    "node",
    shellQuote(options.workerPath),
    options.mode,
  ];
  if (options.mode === "run") {
    if (options.topic === undefined) throw new Error("run command needs a topic");
    args.push("--topic", shellQuote(options.topic));
    if (options.attachmentsManifest !== undefined) {
      args.push("--attachments-manifest", shellQuote(options.attachmentsManifest));
    }
  }
  args.push(
    "--run-id",
    shellQuote(options.runId),
    "--session-root",
    shellQuote(options.sessionRoot),
    "--events-file",
    shellQuote(options.eventsFile),
    "--content-dir",
    shellQuote(options.contentDir),
  );
  if (options.contentRegistryUrl) {
    args.push(
      "--content-registry-url",
      shellQuote(options.contentRegistryUrl),
    );
  }
  if (options.contentRegistryVersion) {
    args.push(
      "--content-registry-version",
      shellQuote(options.contentRegistryVersion),
    );
  }
  if (options.settings.llm.provider === "offline") args.push("--offline");
  if (options.settings.panelConfirmation === "auto") args.push("--auto-approve");
  if (options.gate) {
    const suffix =
      options.gate.action === "shrink"
        ? `:${(options.gate.members ?? []).join(",")}`
        : "";
    args.push(
      "--gate",
      shellQuote(`${options.gate.gateKey}=${options.gate.action}${suffix}`),
    );
  }

  const command = [...modelEnvironment(options.settings), ...args].join(" ");
  if (options.settings.llm.provider === "anthropic") {
    return `# Verified ANTHROPIC_* credentials are injected into the scheduler environment by the brain server.\n${command}`;
  }
  if (options.settings.llm.provider === "claude-agent") {
    return `# The verified CLAUDE_CODE_OAUTH_TOKEN is injected into the scheduler environment by the brain server.\n${command}`;
  }
  return command;
}

export function renderSlurmTemplate(template: string, command: string): string {
  const index = template.indexOf(SLURM_COMMAND_TAG);
  if (index < 0) throw new Error(`SLURM template must contain ${SLURM_COMMAND_TAG}`);
  return `${template.slice(0, index)}${command}${template.slice(
    index + SLURM_COMMAND_TAG.length,
  )}`;
}
