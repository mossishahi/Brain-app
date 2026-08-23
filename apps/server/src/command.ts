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
  /**
   * Panel members dismissed mid-run, accumulated on the job record. Supplied on
   * EVERY submission for the job (every resume path builds its command here),
   * because the runtime holds the list only for the life of one worker process —
   * omitting it on a later resume would put a dismissed seat back to work.
   */
  readonly dismissedMembers?: readonly string[];
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
  }
  // On EVERY mode, not just `run`: the manifest names the root the attachment
  // tools read through, so a resume without it has no attachment store and the
  // capability broker truthfully reports the submitted files as unavailable to
  // every agent from there on. The topic above is genuinely run-only — a resume
  // replays it from the checkpoint — but this is not.
  if (options.attachmentsManifest !== undefined) {
    args.push("--attachments-manifest", shellQuote(options.attachmentsManifest));
  } else {
    // The submission SAYS it carries no files, rather than leaving the worker to
    // conclude it from finding no store. The two look identical on disk — a
    // pruned store, a workspace the compute node cannot see, a launcher that
    // forgot the flag — and only one of them is a run that should carry on.
    // With the declaration, an absence nobody claims is a defect the capability
    // guard can fail on.
    args.push("--attachments", "none");
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
  // The gate-countdown switch is authoritative over both ways a gate can be
  // skipped. `panelConfirmation: "auto"` compiles the gates away in the worker,
  // so a run launched that way has no gate to wait at; with the countdown
  // switched off the submitter has said no gate may pass without them, and this
  // is the only place that can honour it. It can only ever make the pipeline
  // wait MORE than the job's snapshot asked for, never less.
  if (
    options.settings.panelConfirmation === "auto" &&
    options.settings.gateAutoApprove !== false
  ) {
    args.push("--auto-approve");
  }
  if (options.dismissedMembers && options.dismissedMembers.length > 0) {
    // One comma-joined value, not a repeated flag: the worker parses flags into
    // a map, where a repeat would overwrite and silently lose every id but the
    // last. The server sends the FULL accumulated list on every resume.
    args.push("--dismissed-members", shellQuote(options.dismissedMembers.join(",")));
  }
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
  // Per-run workflow-param override (provider-independent): the worker maps
  // it onto the pinned workflow's maxReviewRounds param at run start.
  const reviewEnv =
    options.settings.review?.maxRounds !== undefined
      ? [
          `BRAINSTORM_AGENTIC_MAX_REVIEW_ROUNDS=${shellQuote(
            String(options.settings.review.maxRounds),
          )}`,
        ]
      : [];
  // Panel policy for NEW runs, same channel: the size maps onto the pinned
  // workflow's panelSize param at run start, and the seat switch is a host
  // option the runtime's weave activity honors. Resumes carry both too — a
  // run interrupted before its panel was journaled weaves on resume, and it
  // must weave the way this job was submitted.
  const panelEnv = [
    ...(options.settings.panel?.size !== undefined
      ? [
          `BRAINSTORM_AGENTIC_PANEL_SIZE=${shellQuote(
            String(options.settings.panel.size),
          )}`,
        ]
      : []),
    ...(options.settings.panel?.interdisciplinarySeat === false
      ? ["BRAINSTORM_AGENTIC_INTERDISCIPLINARY_SEAT=off"]
      : []),
  ];
  const command = [
    ...credentialsEnv,
    ...modelEnvironment(options.settings),
    ...reviewEnv,
    ...panelEnv,
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
