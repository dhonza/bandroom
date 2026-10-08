/// <reference lib="webworker" />
import { loadStretch } from "@bandroom/stretch/browser";
import { createFlacCodec, createOpusCodec } from "../decode/wasm";
import type { ToDecoder } from "../mixer/protocol";
import type { WorkerCommand, WorkerEvent } from "../types";
import type { FetchLike } from "./bytes";
import { DecodeScheduler } from "./scheduler";

/** Decoder Web Worker entry (SPEC §6.2): message glue around `DecodeScheduler`. */

declare const self: DedicatedWorkerGlobalScope;

let scheduler: DecodeScheduler | null = null;

const fetchSameOrigin: FetchLike = (url, init) =>
  fetch(url, { ...init, credentials: "same-origin" });

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;
  if (cmd.t === "init") {
    const port = cmd.port;
    scheduler?.dispose();
    const s = new DecodeScheduler(
      {
        fetch: fetchSameOrigin,
        opusCodec: createOpusCodec,
        flacCodec: createFlacCodec,
        stretch: loadStretch,
        toMixer: (msg, transfer) => {
          port.postMessage(msg, transfer);
        },
        toMain: (msg: WorkerEvent) => {
          self.postMessage(msg);
        },
        yieldNow: () =>
          new Promise((resolve) => {
            setTimeout(resolve, 0);
          }),
      },
      cmd.cacheBytes,
      cmd.windowFrames,
    );
    scheduler = s;
    port.onmessage = (ev: MessageEvent<ToDecoder>) => {
      s.fromMixer(ev.data);
    };
    return;
  }
  const s = scheduler;
  if (!s) return;
  switch (cmd.t) {
    case "load":
      s.load(cmd.id, cmd.tracks, cmd.lengthFrames, cmd.mixer);
      break;
    case "source":
      s.setSource(cmd.index, cmd.source, cmd.clips, cmd.offsetDb, cmd.trimDb, cmd.stretch ?? null);
      break;
    case "unload":
      s.unload();
      break;
  }
};
