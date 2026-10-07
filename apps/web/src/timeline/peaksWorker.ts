/// <reference lib="webworker" />
import { buildPyramid, parseDat } from "./peaks";

// Fetches and parses a peaks blob off the main thread (SPEC §11.6).
self.onmessage = async (e: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pyramid = buildPyramid(parseDat(await res.arrayBuffer()));
    const transfer = pyramid.levels.flatMap((l) => [l.mins.buffer, l.maxs.buffer]);
    (self as unknown as Worker).postMessage({ id, pyramid }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
