import type { TakeEndReason } from "@bandroom/audio-engine";
import type { TakeContext, TakeMeta, WriterEvent, WriterRequest } from "./takeTypes";

/**
 * Main-thread side of the take writer worker (SPEC §9): hands it a fresh take port per arming,
 * tells it about each take (Record pressed) and asks it to recover takes on app start.
 */

let worker: Worker | null = null;
let listener: ((e: WriterEvent) => void) | null = null;
let requests = 0;
const waiting = new Map<number, (takes: TakeMeta[]) => void>();
/** A recovery that gets no answer (the worker failed to start) gives up after this long. */
const RECOVER_TIMEOUT_MS = 15_000;

/** Where the worker's events go (the takes store). */
export function setWriterListener(fn: ((e: WriterEvent) => void) | null): void {
  listener = fn;
}

function onEvent(e: WriterEvent): void {
  if (e.type === "recovered") {
    waiting.get(e.requestId)?.(e.takes);
    waiting.delete(e.requestId);
    return;
  }
  listener?.(e);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./takeWriter.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WriterEvent>) => {
    onEvent(e.data);
  };
  worker = w;
  return w;
}

function post(req: WriterRequest, transfer: Transferable[] = []): void {
  getWorker().postMessage(req, transfer);
}

/** A new take port for arming: one end goes to the worklet, the other to the writer. */
export function newTakePort(): MessagePort {
  const channel = new MessageChannel();
  post({ type: "port", port: channel.port2 }, [channel.port2]);
  return channel.port1;
}

/** Record was pressed: the take that starts next belongs to `ctx`. */
export function prepareTake(ctx: TakeContext): void {
  post({ type: "prepare", ctx });
}

/** The audio context went away before the take's end arrived: finish what was written. */
export function finalizeTake(endedBy: TakeEndReason): void {
  post({ type: "finalize", endedBy });
}

/** Finishes takes a crash left behind and lists the user's takes on this device. */
export function recoverTakesOnDevice(userId: string): Promise<TakeMeta[]> {
  const requestId = ++requests;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve([]);
    }, RECOVER_TIMEOUT_MS);
    waiting.set(requestId, (takes) => {
      clearTimeout(timer);
      resolve(takes);
    });
    try {
      post({ type: "recover", userId, requestId });
    } catch {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolve([]);
    }
  });
}

/** Logout: the worker goes (a take in progress was stopped before). */
export function stopTakeWriter(): void {
  worker?.terminate();
  worker = null;
  for (const resolve of waiting.values()) resolve([]);
  waiting.clear();
}
