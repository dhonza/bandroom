import { FLACDecoder } from "@wasm-audio-decoders/flac";
import { OpusDecoder } from "opus-decoder";
import type { FlacCodec, OpusCodec } from "./streams";

/** WASM libopus (MIT). Pre-skip stays 0: `OpusStream` applies it (SPEC §6.5). */
export async function createOpusCodec(channels: number): Promise<OpusCodec> {
  const d = new OpusDecoder({ channels, preSkip: 0 });
  await d.ready;
  return d;
}

/** WASM libFLAC; accepts a stream starting at any frame boundary. */
export async function createFlacCodec(): Promise<FlacCodec> {
  const d = new FLACDecoder();
  await d.ready;
  return d;
}
