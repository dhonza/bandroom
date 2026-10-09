/// <reference lib="webworker" />
import { applyMixerCommand } from "./apply";
import { MixerCore, type MixerEvent, type TakeFree } from "./core";
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
  private pos = { t: "pos" as const, load: 0, frame: 0, lap: 0 } satisfies ToDecoder;
  /** The current song load (see `ToDecoder`). */
  private load = 0;
  /** The take writer's port while armed (SPEC §9). */
  private take: MessagePort | null = null;
  /** Transfer list for take chunks, reused. */
  private transfer: ArrayBuffer[] = [new ArrayBuffer(0)];

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
    if (cmd.t === "recArm") {
      // A take still running ends on its own writer's port.
      this.core.stopCapture("disarmed");
      this.closeTake();
      this.take = cmd.port;
      this.take.onmessage = (e: MessageEvent<TakeFree>) => {
        this.core.addCaptureBuffer(e.data.data);
      };
    }
    applyMixerCommand(this.core, cmd);
    if (cmd.t === "recDisarm") this.closeTake();
    if (cmd.t === "load") {
      this.load = cmd.id;
      this.port.postMessage({ type: "loaded", id: cmd.id });
    }
    // Seeks reach the decoder through the mixer, ordered with loop changes and position reports.
    if (cmd.t === "seek") {
      const msg: ToDecoder = { t: "seek", load: this.load, frame: cmd.frame, lap: cmd.lap };
      this.worker?.postMessage(msg);
    }
  }

  private closeTake() {
    if (!this.take) return;
    this.take.onmessage = null;
    this.take.close();
    this.take = null;
  }

  private onEvent(e: MixerEvent) {
    if (e.type === "take.chunk") {
      // The pooled buffer moves to the take writer (it sends it back when written).
      this.transfer[0] = e.data.buffer as ArrayBuffer;
      this.take?.postMessage(e, this.transfer);
      return;
    }
    if (e.type === "take.gap") {
      this.take?.postMessage(e);
      return;
    }
    if (e.type === "take.start" || e.type === "take.end") {
      this.take?.postMessage(e);
      this.port.postMessage(e);
      return;
    }
    if (e.type === "retime") {
      const { fromLap, frame, base, loop, cache } = e;
      const msg: ToDecoder = { t: "retime", load: this.load, fromLap, frame, base, loop, cache };
      this.worker?.postMessage(msg);
      return;
    }
    // One message per destination per report (position and meters together).
    this.port.postMessage(e);
    if (e.type === "report") {
      this.pos.frame = e.frame;
      this.pos.lap = e.lap;
      this.pos.load = this.load;
      this.worker?.postMessage(this.pos);
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out?.[0];
    if (!l) return true;
    if (this.silent.length < l.length) this.silent = new Float32Array(l.length);
    // The input has no channels unless the microphone is connected (armed).
    this.core.mixBlock(l, out[1] ?? this.silent, l.length, currentTime, inputs[0]);
    return true;
  }
}

registerProcessor("bandroom-mixer", MixerProcessor);
