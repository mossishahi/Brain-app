import type { GpuDiscovery, GpuSetupReport, GpuSlurmParameters } from '@brainstorm-agentic/protocol';

export type GpuFields = { [K in keyof Required<GpuSlurmParameters>]: string };
export function gpuFields(parameters: GpuSlurmParameters): GpuFields {
  return Object.fromEntries(Object.entries({ ...parameters, gpuType: parameters.gpuType ?? '', reservation: parameters.reservation ?? '' }).map(([key, value]) => [key, String(value)])) as GpuFields;
}
export function gpuOptions(discovery: GpuDiscovery | undefined, fields: Pick<GpuFields, 'partition' | 'account'>) {
  const partition = discovery?.partitions.find(item => item.name === fields.partition);
  return { partition, accounts: partition?.accounts ?? [], qos: partition?.accountQos?.[fields.account] ?? partition?.qos ?? [], gpuTypes: partition?.gpuTypes ?? [] };
}
export function changeGpuField(fields: GpuFields, name: keyof GpuFields, value: string, discovery: GpuDiscovery | undefined): GpuFields {
  const next = { ...fields, [name]: value };
  if (name === 'partition') {
    const options = gpuOptions(discovery, next);
    if (!options.accounts.includes(next.account)) next.account = options.accounts[0] ?? '';
    if (!options.gpuTypes.includes(next.gpuType)) next.gpuType = '';
  }
  if (name === 'partition' || name === 'account') {
    const options = gpuOptions(discovery, next);
    if (!options.qos.includes(next.qos)) next.qos = options.qos[0] ?? '';
    next.reservation = '';
  }
  return next;
}
export function gpuTimeMaximum(fields: Pick<GpuFields, 'partition' | 'qos'>, discovery?: GpuDiscovery): number {
  const partition = discovery?.partitions.find(item => item.name === fields.partition);
  const qos = discovery?.qos.find(item => item.name === fields.qos);
  return Math.min(1440, qos?.maxTimeMinutes ?? 1440, qos?.flags.includes('PartitionTimeLimit') ? 1440 : partition?.maxTimeMinutes ?? 1440);
}
export function gpuParameters(fields: GpuFields, discovery?: GpuDiscovery): GpuSlurmParameters {
  const integer = (name: keyof GpuFields, minimum: number, maximum: number) => {
    const value = Number(fields[name]);
    if (!fields[name].trim() || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name}: enter a whole number between ${minimum} and ${maximum}.`);
    return value;
  };
  const options = gpuOptions(discovery, fields);
  if (!options.partition) throw new Error('Choose a discovered GPU partition.');
  if (options.accounts.length && !options.accounts.includes(fields.account)) throw new Error('Choose an account available in this partition.');
  if (options.qos.length && !options.qos.includes(fields.qos)) throw new Error('Choose a QOS available to this account and partition.');
  if (fields.gpuType && !options.gpuTypes.includes(fields.gpuType)) throw new Error('Choose a GPU type available in this partition.');
  if (discovery?.qos.find(item => item.name === fields.qos)?.requiresReservation && !fields.reservation.trim()) throw new Error('This QOS requires a reservation.');
  if (fields.prelude.length > 32_000 || fields.prelude.includes('{{AGENT_COMMAND}}')) throw new Error('Environment setup must be at most 32,000 characters and cannot contain the agent command marker.');
  return {
    partition: fields.partition, account: fields.account, qos: fields.qos,
    ...(fields.gpuType ? { gpuType: fields.gpuType } : {}),
    ...(fields.reservation.trim() ? { reservation: fields.reservation.trim() } : {}),
    gpus: integer('gpus', 1, 64), cpus: integer('cpus', 1, 1024), memoryGb: integer('memoryGb', 1, 65536),
    timeLimitMinutes: integer('timeLimitMinutes', 1, gpuTimeMaximum(fields, discovery)), nice: integer('nice', 0, 2147483645), prelude: fields.prelude,
  };
}
export function gpuStatus(report: GpuSetupReport | null): { label: string; tone: string } {
  if (!report) return { label: 'Loading setup', tone: 'unknown' };
  switch (report.phase) {
    case 'discovering': return { label: 'Discovering GPU setup', tone: 'checking' };
    case 'draft': return { label: 'Pending approval', tone: 'pending' };
    case 'probing': {
      // Submission acceptance is not a queue observation. The server reports
      // FINALIZING after the job leaves the queue while it verifies results.
      const labels: Readonly<Record<string, string>> = {
        SUBMITTED: 'Probe submitted', PENDING: 'Probe queued',
        RUNNING: 'Probe running', EXECUTION_OBSERVED: 'Probe started',
        FINALIZING: 'Checking probe results',
      };
      return { label: labels[report.probe?.state ?? ''] ?? 'Probe in progress', tone: 'checking' };
    }
    case 'ready': return { label: 'Ready', tone: 'ok' };
    case 'failed': return { label: 'Setup needs attention', tone: 'failed' };
    case 'unsupported': return { label: 'No supported GPU queue', tone: 'unknown' };
    default: return { label: 'Not configured', tone: 'unknown' };
  }
}
