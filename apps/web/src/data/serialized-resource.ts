/** Deduplicated reads and ordered mutations shared by every editor of one resource. */
export class SerializedResource<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private reading: Promise<T> | undefined;
  private revision = 0;
  read(load: () => Promise<T>): Promise<T> {
    if (this.reading) return this.reading;
    const readCurrent = async (): Promise<T> => {
      for (;;) {
        const revision = this.revision;
        await this.tail;
        const value = await load();
        // A write started while this read was away. Wait for it and fetch its result.
        if (revision === this.revision) return value;
      }
    };
    const result = readCurrent(); this.reading = result;
    void result.finally(() => { if (this.reading === result) this.reading = undefined; }).catch(() => undefined);
    return result;
  }
  mutate(write: () => Promise<T>, publish: (value: T) => void): Promise<T> {
    this.revision += 1;
    const result = this.tail.then(write).then((value) => { publish(value); return value; });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
