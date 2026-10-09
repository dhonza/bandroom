import type { SyncHandle, TakeDir } from "./takeWriter";

/** In-memory take folder for tests: files are byte arrays; one open handle per file. */
export class FakeTakeDir implements TakeDir {
  readonly files = new Map<string, Uint8Array>();
  readonly locked = new Set<string>();
  /** Names whose `open` fails (another tab holds them). */
  readonly held = new Set<string>();

  open(name: string): Promise<SyncHandle> {
    if (this.held.has(name) || this.locked.has(name)) {
      return Promise.reject(new Error(`NoModificationAllowedError: ${name}`));
    }
    if (!this.files.has(name)) this.files.set(name, new Uint8Array(0));
    this.locked.add(name);
    const files = this.files;
    const locked = this.locked;
    let open = true;
    const get = () => files.get(name) ?? new Uint8Array(0);
    const check = () => {
      if (!open) throw new Error("InvalidStateError: closed");
    };
    return Promise.resolve({
      read(buffer: Uint8Array, opts: { at: number }) {
        check();
        const data = get().subarray(opts.at, opts.at + buffer.length);
        buffer.set(data);
        return data.length;
      },
      write(buffer: Uint8Array, opts: { at: number }) {
        check();
        const cur = get();
        const end = opts.at + buffer.length;
        const next = end > cur.length ? new Uint8Array(end) : cur;
        if (next !== cur) next.set(cur);
        next.set(buffer, opts.at);
        files.set(name, next);
        return buffer.length;
      },
      truncate(size: number) {
        check();
        const cur = get();
        const next = new Uint8Array(size);
        next.set(cur.subarray(0, Math.min(size, cur.length)));
        files.set(name, next);
      },
      getSize() {
        check();
        return get().length;
      },
      flush() {
        check();
      },
      close() {
        open = false;
        locked.delete(name);
      },
    });
  }

  remove(name: string): Promise<void> {
    this.files.delete(name);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  text(name: string): string {
    return new TextDecoder().decode(this.files.get(name));
  }
}
