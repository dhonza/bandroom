import type { MixerCore } from "./core";
import type { MixerCommand } from "./protocol";

/** Applies one command to the mixer (shared by the worklet and Node tests). */
export function applyMixerCommand(core: MixerCore, cmd: MixerCommand): void {
  switch (cmd.t) {
    case "load":
      core.load(cmd.tracks, cmd.lengthFrames);
      break;
    case "chunk":
      core.addChunk(cmd.index, cmd.source, {
        lap: cmd.lap,
        frame: cmd.frame,
        length: cmd.data[0]?.length ?? 0,
        data: cmd.data,
      });
      break;
    case "source":
      core.setSource(
        cmd.index,
        cmd.source,
        cmd.channels,
        cmd.clips,
        cmd.offsetDb,
        cmd.trimDb,
        cmd.dualMono ?? false,
      );
      break;
    case "play":
      core.play(cmd.countIn ?? null);
      break;
    case "pause":
      core.pause();
      break;
    case "seek":
      core.seek(cmd.frame, cmd.lap);
      break;
    case "loop":
      core.setLoop(cmd.loop, cmd.base, cmd.cache);
      break;
    case "track":
      core.setTrack(cmd.index, cmd.params);
      break;
    case "failed":
      core.setFailed(cmd.index, cmd.failed);
      break;
    case "startFrames":
      core.startFrames = cmd.frames;
      break;
    case "clickTrack":
      core.setClickTrack(cmd.frames, cmd.levels);
      break;
    case "click":
      core.setClick(cmd.params);
      break;
    case "repeatCountIn":
      core.setRepeatCountIn(cmd.countIn);
      break;
    case "workerPort":
      break; // handled by the worklet itself
  }
}
