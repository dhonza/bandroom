export type Listener<E, K extends keyof E> = (e: E[K]) => void;

/** A minimal typed event emitter: `on` returns the unsubscribe function. */
export class Emitter<E> {
  private listeners = new Map<keyof E, Set<(e: never) => void>>();

  on<K extends keyof E>(event: K, cb: Listener<E, K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) (cb as Listener<E, K>)(payload);
  }
}
