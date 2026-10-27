import assert from 'node:assert/strict';
import test from 'node:test';
import type { GpuDiscovery } from '@brainstorm-agentic/protocol';
import { changeGpuField, gpuFields, gpuOptions, gpuParameters, gpuStatus, gpuTimeMaximum } from '../src/features/gpu/gpu-model.js';

const discovery: GpuDiscovery = { hostname: 'submit', architecture: 'x86_64', platform: 'linux', scheduler: 'slurm', discoveredAt: '', warnings: [], evidence: [],
  partitions: [{ name: 'gpu_p', accounts: ['normal', 'priority'], qos: ['normal', 'reserved'], gpuTypes: ['a100'], accountQos: { normal: ['normal'], priority: ['reserved'] } }],
  qos: [{ name: 'normal', flags: [], requiresReservation: false }, { name: 'reserved', flags: ['RequiresReservation'], requiresReservation: true }] };
const fields = () => gpuFields({ partition: 'gpu_p', account: 'normal', qos: 'normal', cpus: 2, gpus: 1, memoryGb: 4, timeLimitMinutes: 10, nice: 0, prelude: 'conda activate research' });

test('changing account selects only an allowed QOS and requires a reservation when advertised', () => {
  const next = changeGpuField(fields(), 'account', 'priority', discovery);
  assert.deepEqual(gpuOptions(discovery, next).qos, ['reserved']);
  assert.equal(next.qos, 'reserved');
  assert.throws(() => gpuParameters(next, discovery), /requires a reservation/);
  assert.equal(gpuParameters({ ...next, reservation: 'my-reservation' }, discovery).reservation, 'my-reservation');
});
test('unavailable catalog choices and invalid resources cannot create a draft', () => {
  for (const patch of [{ partition: 'invented' }, { account: 'invented' }, { qos: 'reserved' }, { gpuType: 'invented' }, { gpus: '0' }, { cpus: '2.5' }, { nice: '-1' }, { memoryGb: '' }]) assert.throws(() => gpuParameters({ ...fields(), ...patch }, discovery));
  assert.equal(gpuParameters(fields(), discovery).prelude, 'conda activate research');
});
test('queued probes have a distinct status rather than appearing failed', () => {
  assert.equal(gpuStatus({ phase: 'probing', updatedAt: '', progress: { percent: 25, message: 'Queued' }, probe: { state: 'PENDING', startedAt: '' } }).label, 'Probe queued');
  assert.equal(gpuStatus({ phase: 'draft', updatedAt: '', progress: { percent: 100, message: 'Review' } }).label, 'Pending approval');
});
test('submitted and finalizing probes never claim an observed queue wait', () => {
  for (const [state, expected] of [
    ['SUBMITTED', 'Probe submitted'], ['PENDING', 'Probe queued'],
    ['RUNNING', 'Probe running'], ['EXECUTION_OBSERVED', 'Probe started'],
    ['FINALIZING', 'Checking probe results'],
    ['UNKNOWN', 'Probe in progress'],
  ]) {
    const status = gpuStatus({ phase: 'probing', updatedAt: '', progress: { percent: 30, message: '' }, probe: { state: state!, startedAt: '' } });
    assert.equal(status.label, expected);
    assert.equal(status.tone, 'checking');
  }
  assert.equal(gpuStatus({ phase: 'ready', updatedAt: '', progress: { percent: 100, message: '' }, probe: { state: 'COMPLETED', startedAt: '', finishedAt: '' } }).label, 'Ready');
});
test('QOS time limits respect an explicit partition-time override', () => {
  const catalog = { ...discovery, partitions: [{ ...discovery.partitions[0]!, maxTimeMinutes: 30 }], qos: [{ name: 'normal', maxTimeMinutes: 60, flags: [], requiresReservation: false }] };
  assert.equal(gpuTimeMaximum(fields(), catalog), 30);
  assert.throws(() => gpuParameters({ ...fields(), timeLimitMinutes: '45' }, catalog), /between 1 and 30/);
  const override = { ...catalog, qos: [{ ...catalog.qos[0]!, flags: ['PartitionTimeLimit'] }] };
  assert.equal(gpuTimeMaximum(fields(), override), 60);
  assert.equal(gpuParameters({ ...fields(), timeLimitMinutes: '45' }, override).timeLimitMinutes, 45);
});
