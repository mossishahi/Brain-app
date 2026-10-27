import type { ServerEvent } from '@brainstorm-agentic/protocol';

/** Full snapshots may supersede each other; ordered text deltas must never disappear. */
export function compactEvents(events: readonly ServerEvent[]): ServerEvent[] {
  const latest = new Map<string, number>();
  const key = (event: ServerEvent): string | undefined => event.type === 'job' ? `job:${event.job.jobId}` : event.type === 'jobs' || event.type === 'readiness' ? event.type : undefined;
  events.forEach((event, index) => { const id = key(event); if (id !== undefined) latest.set(id, index); });
  const output: ServerEvent[] = [];
  events.forEach((event, index) => {
    const id = key(event); if (id !== undefined && latest.get(id) !== index) return;
    const previous = output[output.length - 1];
    if (event.type === 'live' && previous?.type === 'live' && previous.jobId === event.jobId) {
      output[output.length - 1] = { ...event, entries: [...previous.entries, ...event.entries] };
    } else output.push(event);
  });
  return output;
}

/** Validate the envelope before accessing nested values in an SSE callback. */
export function isServerEvent(value: unknown): value is ServerEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'job': return !!event.job && typeof event.job === 'object' && 'jobId' in event.job && typeof event.job.jobId === 'string';
    case 'jobs': return Array.isArray(event.jobs);
    case 'readiness': return !!event.readiness && typeof event.readiness === 'object';
    case 'live': return typeof event.jobId === 'string' && Array.isArray(event.entries);
    case 'error': return typeof event.message === 'string';
    default: return false;
  }
}
