import assert from "node:assert/strict";
import { userInfo } from "node:os";
import test from "node:test";
import type { RunSchedulerCommand } from "@brainstorm-agentic/host-tools";
import { defaultGpuParameters, discoverGpuHost, renderGpuSubmission, slurmMinutes, validateGpuParameters } from "../src/gpu-slurm.js";

function fixture(overrides: Readonly<Record<string, string | Error>> = {}): { run: RunSchedulerCommand; calls: string[] } {
  const calls: string[] = [];
  const username = userInfo().username;
  const output: Record<string, string | Error> = {
    "scontrol --version": "slurm 26.05.3\n",
    "scontrol show config": "ClusterName = example\n",
    "scontrol show partition -o": [
      "PartitionName=gpu_p State=UP AllowAccounts=ALL AllowQos=gpu_normal,gpu_priority,gpu_reservation,gpu_long AllowGroups=ALL MaxTime=2-00:00:00",
      "PartitionName=private_gpu State=UP AllowAccounts=ALL AllowQos=private AllowGroups=ALL MaxTime=1-00:00:00",
      "PartitionName=interactive_gpu_p State=UP AllowAccounts=ALL AllowQos=interactive_gpu AllowGroups=ALL MaxTime=12:00:00",
      "PartitionName=cpu_p State=UP AllowAccounts=ALL AllowQos=gpu_normal AllowGroups=ALL MaxTime=1-00:00:00",
    ].join("\n"),
    "sinfo -h -o %P|%a|%l|%G": "gpu_p*|up|2-00:00:00|gpu:h100:8(S:0-1),mps:2200\ngpu_p|up|2-00:00:00|gpu:2\nprivate_gpu|up|1-00:00:00|gpu:4\ninteractive_gpu_p|up|12:00:00|gpu:2\ncpu_p|up|1-00:00:00|(null)\n",
    [`sacctmgr -nP show assoc user=${username} format=Cluster,Account,User,Partition,QOS,DefaultQOS`]: `example|research|${username}||gpu_normal,gpu_reservation,gpu_long,interactive_gpu|gpu_normal\nexample|priority|${username}|gpu_p|gpu_priority|gpu_priority\nother|foreign|${username}||private|private\n`,
    "sacctmgr -nP show qos format=Name,MaxWall,Flags": "gpu_normal|1-00:00:00|DenyOnLimit\ngpu_priority|12:00:00|DenyOnLimit\ngpu_reservation|21-00:00:00|RequiresReservation,PartitionTimeLimit\ngpu_long|3-00:00:00|PartitionTimeLimit\ninteractive_gpu|12:00:00|DenyOnLimit\nprivate||\n",
    "id -Gn": "users researchers\n",
    ...overrides,
  };
  return { calls, run: async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const stdout = output[key];
    if (stdout instanceof Error) throw stdout;
    assert.notEqual(stdout, undefined, `Unexpected command: ${key}`);
    return { exitCode: 0, stdout: stdout!, stderr: "", durationMs: 1, truncated: false, timedOut: false };
  } };
}

test("GPU discovery intersects user associations, partition access and GPU inventory without submission", async () => {
  const scheduler = fixture();
  const found = await discoverGpuHost({ runCommand: scheduler.run });
  assert.equal(found.scheduler, "slurm");
  assert.equal(found.cluster, "example");
  assert.deepEqual(found.partitions.map((p) => p.name), ["gpu_p", "interactive_gpu_p"]);
  assert.deepEqual(found.partitions[0]!.gpuTypes, ["", "h100"]);
  assert.deepEqual(found.partitions[0]!.accountQos, { research: ["gpu_long", "gpu_normal", "gpu_reservation"], priority: ["gpu_priority"] });
  assert.equal(found.qos.find((q) => q.name === "gpu_reservation")!.requiresReservation, true);
  assert.equal(scheduler.calls.some((call) => /sbatch|srun|scancel|nvidia-smi/.test(call)), false);
  assert.equal(found.evidence.length, 7);
});

test("missing scheduler is unsupported; hidden account permissions never become inferred access", async () => {
  const noScheduler = fixture({ "scontrol --version": new Error("ENOENT") });
  const unsupported = await discoverGpuHost({ runCommand: noScheduler.run });
  assert.equal(unsupported.scheduler, "unsupported");
  assert.equal(noScheduler.calls.length, 1);
  const hidden = fixture({ [`sacctmgr -nP show assoc user=${userInfo().username} format=Cluster,Account,User,Partition,QOS,DefaultQOS`]: new Error("Access denied") });
  const found = await discoverGpuHost({ runCommand: hidden.run });
  assert.deepEqual(found.partitions, []);
  assert.match(found.warnings.join(" "), /permissions could not be established/);
});

test("GPU defaults and validation preserve valid account/QOS pairs and require reservations", async () => {
  const found = await discoverGpuHost({ runCommand: fixture().run });
  const initial = defaultGpuParameters(found);
  assert.equal(initial.partition, "gpu_p");
  assert.equal(initial.account, "research");
  assert.equal(initial.qos, "gpu_normal");
  assert.deepEqual(validateGpuParameters(initial, found), initial);
  assert.throws(() => validateGpuParameters({ ...initial, account: "priority", qos: "gpu_normal" }, found), /QOS permitted/);
  const standard = { ...initial, account: "research", qos: "gpu_normal" };
  assert.throws(() => validateGpuParameters({ ...standard, qos: "gpu_reservation" }, found), /requires a reservation/);
  assert.doesNotThrow(() => validateGpuParameters({ ...standard, qos: "gpu_reservation", reservation: "approved-2026" }, found));
  assert.throws(() => validateGpuParameters({ ...standard, timeLimitMinutes: 1441 }, found), /timeLimitMinutes/);
  assert.throws(() => validateGpuParameters({ ...standard, gpuType: "invented" }, found), /GPU type/);
  assert.throws(() => validateGpuParameters({ ...standard, nice: -1 }, found), /nice/);
  assert.throws(() => validateGpuParameters({ ...standard, account: "research\n#SBATCH --exclusive" }, found), /Invalid GPU account/);
  assert.throws(() => validateGpuParameters({ ...standard, reservation: "foo\necho bad" }, found), /reservation/);
  assert.throws(() => validateGpuParameters({ ...standard, reservation: 123 as unknown as string }, found), /reservation/);
});

test("wall validation respects PartitionTimeLimit and bounds deployment runtime", async () => {
  const found = await discoverGpuHost({ runCommand: fixture().run });
  const narrowed = { ...found, partitions: found.partitions.map((part) => ({ ...part, maxTimeMinutes: 10 })) };
  const initial = { ...defaultGpuParameters(found), account: "research", qos: "gpu_normal", timeLimitMinutes: 60 };
  assert.throws(() => validateGpuParameters(initial, narrowed), /between 1 and 10/);
  assert.doesNotThrow(() => validateGpuParameters({ ...initial, qos: "gpu_long" }, narrowed));
  assert.equal(slurmMinutes("2-00:00:00"), 2880);
  assert.equal(slurmMinutes("12:00:00"), 720);
  assert.equal(slurmMinutes("5:30"), 6);
  assert.equal(slurmMinutes("UNLIMITED"), undefined);
});

test("rendered scripts expose all selections and place setup before the agent command", async () => {
  const found = await discoverGpuHost({ runCommand: fixture().run });
  const parameters = validateGpuParameters({ ...defaultGpuParameters(found), gpuType: "h100", prelude: "source /opt/conda/etc/profile.d/conda.sh\nconda activate gpu" }, found);
  const script = renderGpuSubmission(parameters);
  assert.match(script, /#SBATCH --gres=gpu:h100:1/);
  assert.match(script, /#SBATCH --nice=0/);
  assert.match(script, /#SBATCH --account=research/);
  assert.match(script, /set -euo pipefail\nsource/);
  assert.ok(script.indexOf("conda activate gpu") < script.indexOf("{{AGENT_COMMAND}}"));
  assert.match(renderGpuSubmission(parameters, "nvidia-smi"), /nvidia-smi\n$/);
});
