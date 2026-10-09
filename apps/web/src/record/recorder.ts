import {
  CLIP_LEVEL,
  latencyFrames,
  looksLikeBluetooth,
  msToFrames,
  placeTake,
  setRecordingAudioSession,
  type Engine,
  type RecordedTake,
  type RecordingLatency,
  type TakeEndReason,
  type TakePlacement,
} from "@bandroom/audio-engine";
import { create } from "zustand";
import { useTimelineUi } from "../markers/store";
import {
  countInForRecording,
  holdScreenForRecording,
  maxTakeFrames,
  recordingEngine,
  resetPracticeForRecording,
  setRecordingMode,
} from "../rehearse/controller";

/**
 * Recording on the song's engine (SPEC §9), for the record sheet: open the microphone, arm,
 * record a take (the click and the mixer play along), stop. The audio goes from the mixer
 * worklet straight to the take port the caller supplies (its other end is the take writer);
 * this module keeps the state the UI shows and places the take on the timeline.
 */

export type RecorderPhase = "off" | "arming" | "armed" | "recording" | "stopping";

/** A finished take with its estimated placement (before the user's nudge). */
export interface FinishedTake extends RecordedTake {
  /** The latency estimate used (frames): output + input + one render quantum. */
  latencyFrames: number;
  offsetSamples: number;
  trimHead: number;
}

export interface RecorderState {
  phase: RecorderPhase;
  /** Channels recorded: 1, or 2 for a stereo input left on Stereo. */
  channels: 1 | 2;
  /** Channels the input delivers (the Mono/Stereo switch shows for 2). */
  inputChannels: number;
  inputLabel: string;
  /** Input peaks (linear, ~20 Hz) and a clip indicator that stays on until reset. */
  peaks: [number, number];
  clipped: boolean;
  /** Frames recorded so far (the timer). */
  recFrames: number;
  latency: RecordingLatency | null;
  /** Warn: Bluetooth headphones or a large latency estimate. */
  bluetooth: boolean;
  /** Arming reset the practice setting (shown as a notice). */
  practiceReset: boolean;
  /** The last take until the stop dialog takes it (also one ended by an interruption). */
  take: FinishedTake | null;
}

const initial = (): RecorderState => ({
  phase: "off",
  channels: 1,
  inputChannels: 1,
  inputLabel: "",
  peaks: [0, 0],
  clipped: false,
  recFrames: 0,
  latency: null,
  bluetooth: false,
  practiceReset: false,
  take: null,
});

export const useRecorder = create<RecorderState>(initial);

/** `getUserMedia` constraints: no browser processing (SPEC §9), the device and channel count. */
export function inputConstraints(opts: {
  deviceId?: string | undefined;
  channels?: 1 | 2 | undefined;
}): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: opts.channels ?? 2 },
    ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
  };
}

/** The audio inputs (labels once the microphone permission was given). */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
}

/** Opens the microphone (asks for permission the first time). */
export function openInput(
  opts: { deviceId?: string; channels?: 1 | 2 } = {},
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: inputConstraints(opts) });
}

/** Channels the stream's input delivers (1 when the browser does not say). */
export function inputChannelsOf(stream: MediaStream): number {
  const n = stream.getAudioTracks()[0]?.getSettings().channelCount;
  return n === 2 ? 2 : 1;
}

/** Placement with the user's nudge in ms (positive: later on the timeline). */
export function placeFinishedTake(take: FinishedTake, nudgeMs: number): TakePlacement {
  return placeTake(take.startFrame, take.latencyFrames, msToFrames(nudgeMs));
}

interface Session {
  engine: Engine;
  stream: MediaStream;
  off: (() => void)[];
}

let session: Session | null = null;

/** Output device labels (Chrome lists them; elsewhere only the input label is known). */
async function outputLabels(): Promise<string[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audiooutput").map((d) => d.label);
  } catch {
    return [];
  }
}

/**
 * Arms recording on the engine song (the song page's, not a preview): the input is metered and
 * a take can start. Practice goes neutral (notice), the loop goes off, the audio session records
 * and the screen stays on. Takes ownership of `stream` (stopped on disarm). `port` is the take
 * port (transferred to the worklet; see `TakeMessage`).
 */
export async function armRecorder(opts: {
  stream: MediaStream;
  channels: 1 | 2;
  port: MessagePort;
}): Promise<void> {
  const engine = recordingEngine();
  if (!engine) throw new Error("The song is not loaded in the player");
  if (session) disarmRecorder();
  const track = opts.stream.getAudioTracks()[0];
  useRecorder.setState({
    ...initial(),
    phase: "arming",
    channels: opts.channels,
    inputChannels: inputChannelsOf(opts.stream),
    inputLabel: track?.label ?? "",
    practiceReset: resetPracticeForRecording(),
  });
  // Loops are off while recording (SPEC §9).
  useTimelineUi.setState({ loopOn: false });
  setRecordingAudioSession(true);
  holdScreenForRecording(true);
  const s: Session = { engine, stream: opts.stream, off: [] };
  session = s;
  try {
    await engine.armRecording({
      stream: opts.stream,
      channels: opts.channels,
      port: opts.port,
      maxFrames: maxTakeFrames(),
    });
  } catch (err) {
    if (session === s) disarmRecorder();
    throw err;
  }
  if (session !== s) return;
  s.off.push(
    engine.on("input", (m) => {
      useRecorder.setState((st) => ({
        peaks: m.peaks,
        recFrames: m.recFrames,
        clipped: st.clipped || m.peaks[0] >= CLIP_LEVEL || m.peaks[1] >= CLIP_LEVEL,
      }));
    }),
    engine.on("take", onTake),
  );
  const onVisibility = () => {
    // The OS may suspend a hidden page: the take ends cleanly now (SPEC §9).
    if (document.visibilityState === "hidden") stopTake("hidden");
  };
  document.addEventListener("visibilitychange", onVisibility);
  s.off.push(() => {
    document.removeEventListener("visibilitychange", onVisibility);
  });
  const latency = engine.recordingLatency();
  const labels = [track?.label ?? "", ...(await outputLabels())];
  if (session !== s) return;
  useRecorder.setState({
    phase: "armed",
    latency,
    bluetooth: looksLikeBluetooth(labels, latency),
  });
}

/** Starts a take (call inside the tap): count-in first when it is on, then capture. */
export function startRecorder(): void {
  const s = session;
  if (s?.engine.recordingState !== "armed") return;
  setRecordingMode(true);
  // The latency the take will be placed with (the output may have changed since arming).
  useRecorder.setState({
    phase: "recording",
    recFrames: 0,
    take: null,
    latency: s.engine.recordingLatency(),
  });
  s.engine.startRecording({ countIn: countInForRecording() });
}

/** Stop: resolves with the take (also kept in the store for the stop dialog). */
export async function stopRecorder(): Promise<FinishedTake> {
  const s = session;
  if (!s) throw new Error("Not recording");
  useRecorder.setState({ phase: "stopping" });
  const take = await s.engine.stopRecording("user");
  return finished(take);
}

function stopTake(reason: TakeEndReason) {
  const s = session;
  if (s?.engine.recordingState !== "recording") return;
  useRecorder.setState({ phase: "stopping" });
  s.engine.stopRecording(reason).catch(() => undefined);
}

function finished(take: RecordedTake): FinishedTake {
  const latency = useRecorder.getState().latency ?? { outputSec: 0, inputSec: 0 };
  const frames = latencyFrames(latency);
  return { ...take, latencyFrames: frames, ...placeTake(take.startFrame, frames) };
}

/** Every take end (Stop, max length, interruption, input gone): the stop dialog shows it. */
function onTake(take: RecordedTake) {
  setRecordingMode(false);
  useRecorder.setState({ phase: session ? "armed" : "off", take: finished(take) });
}

/** The stop dialog took the take (saved or discarded). */
export function clearTake(): void {
  useRecorder.setState({ take: null });
}

export function resetClip(): void {
  useRecorder.setState({ clipped: false });
}

/** Disconnects and closes the microphone; a take in progress ends (`disarmed`). */
export function disarmRecorder(): void {
  const s = session;
  if (!s) return;
  session = null;
  s.engine.disarmRecording();
  for (const off of s.off) off();
  for (const t of s.stream.getTracks()) t.stop();
  setRecordingAudioSession(false);
  holdScreenForRecording(false);
  setRecordingMode(false);
  useRecorder.setState((st) => ({ ...initial(), take: st.take }));
}
