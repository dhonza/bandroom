import { useEffect, useState } from "react";
import { blobUrl } from "../lib/media";
import { buildPyramid, parseDat, type Pyramid } from "./peaks";

type Pending = { resolve: (p: Pyramid) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();
/** Parsed pyramids by blob hash (content-addressed: never stale). Bounded (SPEC §19.6 spirit). */
const cache = new Map<string, Promise<Pyramid>>();
const CACHE_MAX = 64;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./peaksWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; pyramid?: Pyramid; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (!p) return;
      if (e.data.pyramid) p.resolve(e.data.pyramid);
      else p.reject(new Error(e.data.error ?? "peaks failed"));
    };
    // A broken worker (failed module load, uncloneable reply) answers nothing more: fail what is
    // pending and parse on the main thread from now on.
    worker.onerror = worker.onmessageerror = () => {
      abandonWorker();
    };
  } catch {
    worker = null; // e.g. tests: parse on the main thread instead
  }
  return worker;
}

function abandonWorker() {
  worker?.terminate();
  worker = null;
  const failed = [...pending.values()];
  pending.clear();
  for (const p of failed) p.reject(new Error("peaks worker failed"));
}

async function loadOnMainThread(url: string): Promise<Pyramid> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return buildPyramid(parseDat(await res.arrayBuffer()));
}

export function loadPeaks(hash: string): Promise<Pyramid> {
  const hit = cache.get(hash);
  if (hit) return hit;
  const url = blobUrl(hash);
  const w = getWorker();
  const p = w
    ? new Promise<Pyramid>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, url });
      })
    : loadOnMainThread(url);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(hash, p);
  p.catch(() => cache.delete(hash));
  return p;
}

/** Peaks for several blobs; entries are null until loaded (or when the hash is null). */
export function usePeaks(hashes: readonly (string | null)[]): (Pyramid | null)[] {
  const key = hashes.join(",");
  const [state, setState] = useState<{ key: string; values: (Pyramid | null)[] }>({
    key,
    values: hashes.map(() => null),
  });
  useEffect(() => {
    let alive = true;
    const list = key.split(",").map((h) => (h === "" || h === "null" ? null : h));
    void Promise.all(
      list.map((h) => (h ? loadPeaks(h).catch(() => null) : Promise.resolve(null))),
    ).then((values) => {
      if (alive) setState({ key, values });
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return state.key === key ? state.values : hashes.map(() => null);
}
