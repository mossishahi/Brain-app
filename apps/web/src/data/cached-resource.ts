export interface CachedSnapshot<T> {
  readonly value: T | null;
  readonly loading: boolean;
  readonly error: unknown;
}

/** A stored launch snapshot. Readers never refresh it merely by opening a view. */
export class CachedResource<T> {
  private snapshot: CachedSnapshot<T> = { value: null, loading: false, error: null };
  private pending: Promise<T> | undefined;
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(private readonly load: () => Promise<T>) {}
  getSnapshot = (): CachedSnapshot<T> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: CachedSnapshot<T>): void {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
  read = (): Promise<T> => {
    if (!this.snapshot.loading && this.snapshot.value !== null) return Promise.resolve(this.snapshot.value);
    return this.pending ?? this.refresh();
  };
  refresh = (): Promise<T> => {
    const revision = ++this.revision;
    this.publish({ value: this.snapshot.value, loading: true, error: null });
    const pending = Promise.resolve().then(this.load).then(value => {
      if (revision === this.revision) this.publish({ value, loading: false, error: null });
      return value;
    }, error => {
      if (revision === this.revision) this.publish({ value: this.snapshot.value, loading: false, error });
      throw error;
    });
    this.pending = pending;
    return pending;
  };
}
