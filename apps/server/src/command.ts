import {
  SLURM_COMMAND_TAG,
  type CustomSeatRequest,
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
  /**
   * Owner-only credentials file the worker may read secrets from. Set on
   * submission channels that cannot inject a scheduler environment (held
   * pilots are queued long before the run exists, with --export=NONE). The
   * PATH is not a secret; the file is 0600 on shared storage.
   */
  readonly credentialsFile?: string;
  readonly settings: ServerSettings;
  readonly gate?: {
    readonly gateKey: string;
    readonly action: "approve" | "shrink" | "revise";
    readonly members?: readonly string[];
    /** Custom seats added at confirmation; forces the JSON gate transport. */
    readonly addedMembers?: readonly CustomSeatRequest[];
    /** Classification revision: the type to proceed with (JSON transport). */
    readonly type?: string;
    /** Classification revision: the replacement asks (JSON transport). */
    readonly requestedOutputs?: readonly { title: string; ask: string }[];
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
  // The JSON form is authoritative for the worker: it round-trips any route
  // name losslessly (the per-route variables above mangle non-alphanumerics
  // and remain only for older resume scripts).
  const modelsByRoute = settings.llm.modelsByRoute ?? {};
  if (Object.keys(modelsByRoute).length > 0) {
    entries.push(
      `BRAINSTORM_AGENTIC_MODELS_BY_ROUTE=${shellQuote(JSON.stringify(modelsByRoute))}`,
    );
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
    const needsJson =
      (options.gate.addedMembers && options.gate.addedMembers.length > 0) ||
      options.gate.type !== undefined ||
      options.gate.requestedOutputs !== undefined;
    if (needsJson) {
      // Custom seats and classification revisions do not fit the compact
      // key=action[:ids] syntax; the JSON transport carries the full response.
      args.push(
        "--gate-json",
        shellQuote(
          JSON.stringify({
            gateKey: options.gate.gateKey,
            action: options.gate.action,
            ...(options.gate.members ? { members: options.gate.members } : {}),
            ...(options.gate.addedMembers && options.gate.addedMembers.length > 0
              ? { addedMembers: options.gate.addedMembers }
              : {}),
            ...(options.gate.type !== undefined ? { type: options.gate.type } : {}),
            ...(options.gate.requestedOutputs !== undefined
              ? { requestedOutputs: options.gate.requestedOutputs }
              : {}),
          }),
        ),
      );
    } else {
      const suffix =
        options.gate.action === "shrink"
          ? `:${(options.gate.members ?? []).join(",")}`
          : "";
      args.push(
        "--gate",
        shellQuote(`${options.gate.gateKey}=${options.gate.action}${suffix}`),
      );
    }
  }

  const credentialsEnv =
    options.credentialsFile !== undefined && options.settings.llm.provider !== "offline"
      ? [`BRAINSTORM_AGENTIC_CREDENTIALS_FILE=${shellQuote(options.credentialsFile)}`]
      : [];
  const command = [
    ...credentialsEnv,
    ...modelEnvironment(options.settings),
    ...args,
  ].join(" ");
  if (options.credentialsFile !== undefined && options.settings.llm.provider !== "offline") {
    return (
      "# Credentials are read from the owner-only credentials file (held pilots\n" +
      "# cannot receive a scheduler environment).\n" +
      command
    );
  }
  if (options.settings.llm.provider === "anthropic") {
    return `# Verified ANTHROPIC_* credentials are injected into the scheduler environment by the brain server.\n${command}`;
  }
  if (options.settings.llm.provider === "claude-agent") {
    return `# The verified CLAUDE_CODE_OAUTH_TOKEN is injected into the scheduler environment by the brain server.\n${command}`;
  }
  if (options.settings.llm.provider === "cursor-agent") {
    return `# The verified CURSOR_API_KEY is injected into the scheduler environment by the brain server.\n${command}`;
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
