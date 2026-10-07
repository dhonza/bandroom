/**
 * Bounded in-memory memory of keys seen recently (access decisions, view and play dedupe). When
 * full it is simply cleared: the worst case is one repeated check or log entry (SPEC §19.6).
 */
export class BoundedRecent {
  private readonly seen = new Map<string, number>();

  /**
   * @param windowMs how long a key counts as recent after it was marked
   * @param max entries kept before the memory is cleared
   * @param inclusive whether a key exactly `windowMs` old still counts as recent
   */
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly inclusive = false,
  ) {}

  isRecent(key: string, now: number): boolean {
    const last = this.seen.get(key);
    if (last === undefined) return false;
    return this.inclusive ? now - last <= this.windowMs : now - last < this.windowMs;
  }

  mark(key: string, now: number): void {
    if (this.seen.size >= this.max) this.seen.clear();
    this.seen.set(key, now);
  }

  /** Marks the key; false when it was already marked within the window (then left as is). */
  markIfNew(key: string, now: number): boolean {
    if (this.isRecent(key, now)) return false;
    this.mark(key, now);
    return true;
  }
}
