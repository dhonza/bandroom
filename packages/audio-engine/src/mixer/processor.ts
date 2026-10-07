/// <reference lib="webworker" />
import { applyMixerCommand } from "./apply";
import { MixerCore, type MixerEvent } from "./core";
import type { MixerCommand, ToDecoder } from "./protocol";

/**
 * AudioWorklet entry (SPEC §6.2): a thin shell around `MixerCore`. Commands arrive on the node's
 * port (main thread) and on a second port from the decoder worker (PCM chunks, sources, load).
 */

declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

class MixerProcessor extends AudioWorkletProcessor {
  private readonly core = new MixerCore((e) => {
    this.onEvent(e);
  });
  private worker: MessagePort | null = null;
  private silent = new Float32Array(128);
  /** Playhead report to the decoder, reused (postMessage clones it). */
  private pos = { t: "pos" as const, frame: 0, lap: 0 } satisfies ToDecoder;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<MixerCommand>) => {
      this.command(e.data);
    };
  }

  private command(cmd: MixerCommand) {
    if (cmd.t === "workerPort") {
      this.worker = cmd.port;
      this.worker.onmessage = (e: MessageEvent<MixerCommand>) => {
        this.command(e.data);
      };
      return;
    }
    applyMixerCommand(this.core, cmd);
    if (cmd.t === "load") this.port.postMessage({ type: "loaded", id: cmd.id });
    // Seeks reach the decoder through the mixer, ordered with loop changes and position reports.
    if (cmd.t === "seek") {
      const msg: ToDecoder = { t: "seek", frame: cmd.frame, lap: cmd.lap };
      this.worker?.postMessage(msg);
    }
  }

  private onEvent(e: MixerEvent) {
    if (e.type === "retime") {
      const { fromLap, frame, base, loop, cache } = e;
      const msg: ToDecoder = { t: "retime", fromLap, frame, base, loop, cache };
      this.worker?.postMessage(msg);
      return;
    }
    // One message per destination per report (position and meters together).
    this.port.postMessage(e);
    if (e.type === "report") {
      this.pos.frame = e.frame;
      this.pos.lap = e.lap;
      this.worker?.postMessage(this.pos);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out?.[0];
    if (!l) return true;
    if (this.silent.length < l.length) this.silent = new Float32Array(l.length);
    this.core.mixBlock(l, out[1] ?? this.silent, l.length, currentTime);
    return true;
  }
}

registerProcessor("bandroom-mixer", MixerProcessor);
