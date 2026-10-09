/// <reference lib="webworker" />
import type { TakeFree, TakeMessage } from "@bandroom/audio-engine";
import { recoverTakes, TakeWriter, type SyncHandle, type TakeDir } from "./takeWriter";
import type { WriterEvent, WriterRequest } from "./takeTypes";

/**
 * The take writer worker (SPEC §9): a thin shell over `TakeWriter` with OPFS synchronous access
 * handles. It owns the take port (the mixer worklet's other end) and reports to the main thread.
 */

declare const self: DedicatedWorkerGlobalScope;

async function opfsDir(userId: string): Promise<TakeDir> {
  const root = await navigator.storage.getDirectory();
  const takes = await root.getDirectoryHandle("takes", { create: true });
  const dir = await takes.getDirectoryHandle(userId, { create: true });
  return {
    open: async (name) => {
      const file = await dir.getFileHandle(name, { create: true });
      const handle: SyncHandle = await file.createSyncAccessHandle();
      return handle;
    },
    remove: (name) => dir.removeEntry(name),
    list: async () => {
      const names: string[] = [];
      const entries = dir as unknown as { keys(): AsyncIterable<string> };
      for await (const name of entries.keys()) names.push(name);
      return names;
    },
  };
}

let port: MessagePort | null = null;

const emit = (e: WriterEvent) => {
  self.postMessage(e);
};

const writer = new TakeWriter({
  dir: opfsDir,
  emit,
  free: (data) => {
    const msg: TakeFree = { t: "free", data };
    port?.postMessage(msg, [data.buffer]);
  },
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
});

self.onmessage = (e: MessageEvent<WriterRequest>) => {
  const req = e.data;
  if (req.type === "port") {
    port?.close();
    port = req.port;
    port.onmessage = (m: MessageEvent<TakeMessage>) => {
      writer.message(m.data);
    };
  } else if (req.type === "prepare") {
    writer.prepare(req.ctx);
  } else if (req.type === "finalize") {
    writer.finalize(req.endedBy);
  } else {
    void (async () => {
      await writer.idle();
      const active = writer.activeTakeId;
      let takes: WriterEvent & { type: "recovered" };
      try {
        const dir = await opfsDir(req.userId);
        const list = await recoverTakes(dir, {
          skip: new Set(active ? [active] : []),
          now: () => Date.now(),
        });
        takes = { type: "recovered", requestId: req.requestId, takes: list };
      } catch {
        takes = { type: "recovered", requestId: req.requestId, takes: [] };
      }
      emit(takes);
    })();
  }
};
