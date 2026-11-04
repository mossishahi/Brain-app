/** Deduplicated reads and ordered mutations shared by every editor of one resource. */
export class SerializedResource<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private reading: Promise<T> | undefined;
  private revision = 0;
  private value: T | undefined;
  getSnapshot = (): T | undefined => this.value;
  read(load: () => Promise<T>): Promise<T> {
    if (this.reading) return this.reading;
    const readCurrent = async (): Promise<T> => {
      for (;;) {
        const revision = this.revision;
        const value = await load();
        // Reads must stay available while another editor saves. Only retry a
        // read crossed by a write, so a late response cannot restore old data.
        if (revision === this.revision) { this.value = value; return value; }
      }
    };
    const result = readCurrent(); this.reading = result;
    void result.finally(() => { if (this.reading === result) this.reading = undefined; }).catch(() => undefined);
    return result;
  }
  mutate(write: () => Promise<T>, publish: (value: T) => void): Promise<T> {
    this.revision += 1;
    const result = this.tail.then(write).then((value) => {
      this.revision += 1;
      this.value = value;
      publish(value);
      return value;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
