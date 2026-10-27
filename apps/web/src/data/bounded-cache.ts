/** LRU with an explicit weight budget. Oversized values remain owned by the active view. */
export class BoundedCache<K, V> {
  private readonly values = new Map<K, { value: V; weight: number; expires: number }>();
  private weight = 0;
  constructor(private readonly maxEntries: number, private readonly maxWeight: number, private readonly ttl: number, private readonly now: () => number = Date.now) {}
  get(key: K): V | undefined {
    const item = this.values.get(key);
    if (!item) return undefined;
    if (item.expires <= this.now()) { this.delete(key); return undefined; }
    this.values.delete(key); this.values.set(key, item);
    return item.value;
  }
  set(key: K, value: V, weight: number): void {
    this.delete(key);
    if (!Number.isFinite(weight) || weight > this.maxWeight || weight < 0) return;
    this.values.set(key, { value, weight, expires: this.now() + this.ttl }); this.weight += weight;
    while (this.values.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.values.keys().next(); if (oldest.done) break; this.delete(oldest.value);
    }
  }
  delete(key: K): void { const item = this.values.get(key); if (item) this.weight -= item.weight; this.values.delete(key); }
  get size(): number { return this.values.size; }
  get totalWeight(): number { return this.weight; }
}
