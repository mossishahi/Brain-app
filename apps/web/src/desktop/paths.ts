/** A connection is immutable for the lifetime of a loaded research page. */
export function connectionIdFromPath(pathname: string, launcher: boolean): string | undefined {
  if (!launcher) return undefined;
  return /^\/connections\/([A-Za-z0-9_-]+)\/(?:.*)?$/.exec(pathname)?.[1];
}

export function researchApiBase(pathname: string, launcher: boolean): string {
  const id = connectionIdFromPath(pathname, launcher);
  return id ? `/connections/${id}/api` : '/api';
}

export function connectionPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid connection identifier');
  return `/connections/${id}/`;
}

/** Drafts and onboarding belong to their host; appearance stays laptop-wide. */
export function scopedStorageKey(key: string, pathname: string, launcher: boolean): string {
  const id = connectionIdFromPath(pathname, launcher);
  return id ? `${key}:connection:${id}` : key;
}
