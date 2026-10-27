/** Read-only scheduler discovery and deterministic rendering of reviewed GPU jobs. */
import { arch, hostname, platform, userInfo } from "node:os";
import { runProcess, scrubbedEnvironment, type RunSchedulerCommand } from "@brainstorm-agentic/host-tools";
import { GPU_COMMAND_TAG, type GpuDiscovery, type GpuPartition, type GpuQos, type GpuSlurmParameters } from "@brainstorm-agentic/protocol";

const NAME = /^[A-Za-z0-9_.+-]+$/;
const list = (value: string | undefined): string[] =>
  !value || ["ALL", "N/A", "(null)", "NONE"].includes(value) ? [] : value.split(",").filter(Boolean);

export function slurmMinutes(value: string | undefined): number | undefined {
  if (!value || /^(UNLIMITED|INFINITE|NONE|N\/A)$/i.test(value)) return undefined;
  const match = /^(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?$/.exec(value);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const first = Number(match[2]);
  if (match[1] || match[4] !== undefined) return days * 1440 + first * 60 + Number(match[3] ?? 0) + Math.ceil(Number(match[4] ?? 0) / 60);
  return first + Math.ceil(Number(match[3] ?? 0) / 60);
}

function fields(line: string): Record<string, string> {
  return Object.fromEntries([...line.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]*)/g)].map((match) => [match[1]!, match[2]!]));
}

export interface DiscoverGpuHostOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly runCommand?: RunSchedulerCommand;
}

export async function discoverGpuHost(options: DiscoverGpuHostOptions = {}): Promise<GpuDiscovery> {
  const evidence: Array<GpuDiscovery["evidence"][number]> = [];
  const warnings: string[] = [];
  const env = scrubbedEnvironment(options.env ?? process.env);
  const run = options.runCommand ?? ((command, args, input) => runProcess(command, args, { ...input, env }));
  const query = async (command: string, args: readonly string[]): Promise<string | undefined> => {
    if (options.signal?.aborted) throw new Error("GPU discovery cancelled");
    try {
      const result = await run(command, args, { cwd: process.cwd(), timeoutMs: 10_000, ...(options.signal ? { signal: options.signal } : {}) });
      evidence.push({ command: [command, ...args].join(" "), stdout: result.stdout.slice(0, 48_000), stderr: result.stderr.slice(0, 8_000), exitCode: result.exitCode });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) {
        warnings.push(`${command} discovery failed or returned incomplete output; see evidence.`);
        return undefined;
      }
      return result.stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      evidence.push({ command: [command, ...args].join(" "), stdout: "", stderr: detail, exitCode: -1 });
      warnings.push(`${command} is unavailable: ${detail}`);
      return undefined;
    }
  };
  const base = { hostname: hostname(), architecture: arch(), platform: platform(), discoveredAt: new Date().toISOString() };
  const version = await query("scontrol", ["--version"]);
  if (version === undefined) return { ...base, scheduler: "unsupported", partitions: [], qos: [], warnings, evidence };
  const username = userInfo().username;
  const [partitionText, inventory, associations, qosText, configuration, groupText] = await Promise.all([
    query("scontrol", ["show", "partition", "-o"]),
    query("sinfo", ["-h", "-o", "%P|%a|%l|%G"]),
    query("sacctmgr", ["-nP", "show", "assoc", `user=${username}`, "format=Cluster,Account,User,Partition,QOS,DefaultQOS"]),
    query("sacctmgr", ["-nP", "show", "qos", "format=Name,MaxWall,Flags"]),
    query("scontrol", ["show", "config"]),
    query("id", ["-Gn"]),
  ]);
  if (options.signal?.aborted) throw new Error("GPU discovery cancelled");
  const cluster = /^\s*ClusterName\s*=\s*(\S+)/m.exec(configuration ?? "")?.[1];
  const groups = new Set((groupText ?? "").trim().split(/\s+/));
  const qos: GpuQos[] = (qosText ?? "").split("\n").filter((line) => line.trim()).map((line) => {
    const [name = "", maxWall, rawFlags] = line.trim().split("|");
    const flags = list(rawFlags);
    const maxTimeMinutes = slurmMinutes(maxWall);
    return { name, ...(maxTimeMinutes !== undefined ? { maxTimeMinutes } : {}), flags, requiresReservation: flags.includes("RequiresReservation") };
  }).filter((entry) => NAME.test(entry.name));
  const knownQos = new Set(qos.map((entry) => entry.name));
  const assoc = (associations ?? "").split("\n").filter(Boolean).map((line) => {
    const [associationCluster, account = "", user, partition, rawQos] = line.trim().split("|");
    return { cluster: associationCluster, account, user, partition, qos: list(rawQos) };
  }).filter((entry) => entry.user === username && (!cluster || entry.cluster === cluster));
  if (associations === undefined || assoc.length === 0) warnings.push("GPU account permissions could not be established; no partition is enabled for submission.");
  const gpuTypes = new Map<string, Set<string>>();
  for (const line of (inventory ?? "").split("\n")) {
    const [rawName = "", , , gres = ""] = line.split("|");
    const name = rawName.replace(/\*$/, "");
    for (const match of gres.matchAll(/(?:^|,)gpu:(?:([A-Za-z0-9_.+-]+):)?\d+(?:\([^)]*\))?/g)) {
      if (!gpuTypes.has(name)) gpuTypes.set(name, new Set([""]));
      if (match[1]) gpuTypes.get(name)!.add(match[1]);
    }
  }
  const partitions: GpuPartition[] = [];
  for (const line of (partitionText ?? "").split("\n")) {
    const part = fields(line);
    const name = part.PartitionName;
    if (!name || !NAME.test(name) || !gpuTypes.has(name) || part.State !== "UP" || part.RootOnly === "YES") continue;
    if (part.AllowGroups && part.AllowGroups !== "ALL" && !list(part.AllowGroups).some((group) => groups.has(group))) continue;
    const accountQos: Record<string, string[]> = {};
    for (const row of assoc) {
      if (row.partition && row.partition !== name) continue;
      if (part.AllowAccounts && part.AllowAccounts !== "ALL" && !list(part.AllowAccounts).includes(row.account)) continue;
      if (list(part.DenyAccounts).includes(row.account)) continue;
      const permitted = row.qos.filter((q) => knownQos.has(q)
        && (!part.AllowQos || part.AllowQos === "ALL" || list(part.AllowQos).includes(q))
        && !list(part.DenyQos).includes(q));
      if (permitted.length > 0 && NAME.test(row.account)) accountQos[row.account] = [...new Set([...(accountQos[row.account] ?? []), ...permitted])].sort();
    }
    const accounts = Object.keys(accountQos).sort();
    if (accounts.length === 0) continue;
    const maxTimeMinutes = slurmMinutes(part.MaxTime);
    const partitionWarnings: string[] = [];
    if (part.ReqResv === "YES") partitionWarnings.push("This partition requires a reservation.");
    if (part.QoS && part.QoS !== "N/A") partitionWarnings.push(`Partition QOS ${part.QoS} may add limits; the scheduler validates these at submission.`);
    partitions.push({ name, accounts, qos: [...new Set(Object.values(accountQos).flat())].sort(), accountQos,
      gpuTypes: [...gpuTypes.get(name)!].sort(), ...(maxTimeMinutes !== undefined ? { maxTimeMinutes } : {}),
      interactive: /interactive/i.test(name), ...(partitionWarnings.length ? { warnings: partitionWarnings } : {}) });
  }
  partitions.sort((a, b) => Number(a.interactive) - Number(b.interactive) || a.name.localeCompare(b.name));
  warnings.push("Discovery identifies permitted queues, not free GPUs. Account, group, resource and reservation limits remain scheduler-enforced.");
  if (partitions.length === 0) warnings.push("No accessible GPU partition was established from scheduler inventory and this user's associations.");
  return { ...base, scheduler: "slurm", schedulerVersion: version.trim(), ...(cluster ? { cluster } : {}), partitions, qos, warnings, evidence };
}

function wallLimit(partition: GpuPartition, qos: GpuQos | undefined): number {
  // PartitionTimeLimit explicitly allows this QOS to exceed partition MaxTime.
  const partitionLimit = qos?.flags.includes("PartitionTimeLimit") ? Infinity : partition.maxTimeMinutes ?? Infinity;
  return Math.min(1440, partitionLimit, qos?.maxTimeMinutes ?? Infinity);
}

export function defaultGpuParameters(discovery: GpuDiscovery): GpuSlurmParameters {
  const partition = discovery.partitions.find((part) => part.qos.some((name) => !discovery.qos.find((q) => q.name === name)?.requiresReservation));
  if (!partition) throw new Error("No GPU partition with a usable account and QOS was discovered.");
  const choices = partition.accounts.flatMap((account) => (partition.accountQos?.[account] ?? partition.qos)
    .filter((name) => !discovery.qos.find((q) => q.name === name)?.requiresReservation).map((qos) => ({ account, qos })));
  const chosen = choices.find(({ qos }) => /(?:^|_)normal$/.test(qos)) ?? choices[0];
  if (!chosen) throw new Error("The discovered account has no QOS usable without a reservation.");
  const { account, qos } = chosen;
  return { partition: partition.name, account, qos, gpus: 1, cpus: 1, memoryGb: 4,
    timeLimitMinutes: Math.min(60, wallLimit(partition, discovery.qos.find((q) => q.name === qos))), nice: 0, prelude: "" };
}

export function validateGpuParameters(parameters: GpuSlurmParameters, discovery: GpuDiscovery): GpuSlurmParameters {
  if (!parameters || typeof parameters !== "object") throw new Error("GPU parameters must be an object.");
  const partition = discovery.partitions.find((part) => part.name === parameters.partition);
  if (discovery.scheduler !== "slurm" || !partition) throw new Error("Select a discovered SLURM GPU partition.");
  for (const [label, value] of Object.entries({ partition: parameters.partition, account: parameters.account, qos: parameters.qos })) {
    if (typeof value !== "string" || (value !== "" && !NAME.test(value))) throw new Error(`Invalid GPU ${label}.`);
  }
  if (!partition.accounts.includes(parameters.account)) throw new Error("Select an account permitted on this partition.");
  if (!(partition.accountQos?.[parameters.account] ?? partition.qos).includes(parameters.qos)) throw new Error("Select a QOS permitted for this account and partition.");
  if (parameters.gpuType && !partition.gpuTypes.includes(parameters.gpuType)) throw new Error("Select a discovered GPU type.");
  const qos = discovery.qos.find((entry) => entry.name === parameters.qos);
  if (parameters.reservation !== undefined && (typeof parameters.reservation !== "string" || (parameters.reservation !== "" && !NAME.test(parameters.reservation)))) throw new Error("Invalid reservation name.");
  if ((qos?.requiresReservation || partition.warnings?.some((warning) => warning === "This partition requires a reservation.")) && !parameters.reservation?.trim()) throw new Error("This partition or QOS requires a reservation.");
  const limits = { gpus: [1, 64], cpus: [1, 1024], memoryGb: [1, 65536], timeLimitMinutes: [1, wallLimit(partition, qos)], nice: [0, 2147483645] };
  for (const [name, [min, max]] of Object.entries(limits)) {
    const value = parameters[name as keyof GpuSlurmParameters];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min! || value > max!) throw new Error(`GPU ${name} must be an integer between ${min} and ${max}.`);
  }
  if (typeof parameters.prelude !== "string" || parameters.prelude.length > 32_000 || parameters.prelude.includes("\0") || parameters.prelude.includes(GPU_COMMAND_TAG)) throw new Error("Environment setup must be at most 32000 characters and cannot contain the agent command marker.");
  return { partition: parameters.partition, account: parameters.account, qos: parameters.qos,
    ...(parameters.gpuType ? { gpuType: parameters.gpuType } : {}),
    gpus: parameters.gpus, cpus: parameters.cpus, memoryGb: parameters.memoryGb,
    timeLimitMinutes: parameters.timeLimitMinutes, nice: parameters.nice,
    ...(parameters.reservation ? { reservation: parameters.reservation } : {}), prelude: parameters.prelude };
}

/** Parameters must first pass validateGpuParameters against fresh discovery. */
export function renderGpuSubmission(parameters: GpuSlurmParameters, body = GPU_COMMAND_TAG): string {
  const lines = ["#!/usr/bin/env bash", `#SBATCH --partition=${parameters.partition}`,
    ...(parameters.account ? [`#SBATCH --account=${parameters.account}`] : []),
    ...(parameters.qos ? [`#SBATCH --qos=${parameters.qos}`] : []),
    `#SBATCH --nodes=1`, `#SBATCH --ntasks=1`,
    `#SBATCH --gres=gpu:${parameters.gpuType ? `${parameters.gpuType}:` : ""}${parameters.gpus}`,
    `#SBATCH --cpus-per-task=${parameters.cpus}`, `#SBATCH --mem=${parameters.memoryGb}G`,
    `#SBATCH --time=${parameters.timeLimitMinutes}`, `#SBATCH --nice=${parameters.nice}`,
    ...(parameters.reservation ? [`#SBATCH --reservation=${parameters.reservation}`] : []),
    "", "set -euo pipefail", ...(parameters.prelude.trim() ? [parameters.prelude] : []), "", body, ""];
  return lines.join("\n");
}
