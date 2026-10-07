import { Session } from "node:inspector/promises";
import { describe, expect, it } from "vitest";
import { MixerCore, type MixerEvent, type MixerTrackConfig } from "./core";

/**
 * The render loop must not allocate (CLAUDE.md, SPEC §6.2): garbage collection in the audio
 * thread causes dropouts. V8's sampling heap profiler (including objects already collected)
 * attributes allocations to functions; the mixer's own functions must account for almost none.
 * A small allowance covers V8 internals (heap numbers after a deopt); the version before the
 * fix allocated ~150 kB in the same run.
 */

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
}

function mixerBytes(node: ProfileNode, out: string[]): number {
  let n = 0;
  const url = node.callFrame.url;
  if (node.selfSize > 0 && /\/src\/mixer\//.test(url) && !url.endsWith(".test.ts")) {
    n += node.selfSize;
    out.push(`${node.callFrame.functionName}:${node.callFrame.lineNumber} ${node.selfSize}`);
  }
  for (const c of node.children) n += mixerBytes(c, out);
  return n;
}

const track = (id: string, pan: number): MixerTrackConfig => ({
  id,
  source: 1,
  channels: id === "mono" ? 1 : 2,
  clips: [{ start: 0, end: 48_000 * 600 }],
  gainDb: -3,
  pan,
  mute: false,
  solo: false,
});

describe("MixerCore allocations", () => {
  it("mixBlock allocates nothing while playing and reporting", async () => {
    const reports = new Set<MixerEvent>();
    const m = new MixerCore((e) => {
      if (e.type === "report") reports.add(e);
    });
    m.startFrames = 1024;
    m.load([track("a", 0.3), track("mono", -0.5)], 48_000 * 600);
    for (let f = 0; f < 48_000 * 120; f += 4096) {
      m.addChunk(0, 1, {
        lap: 0,
        frame: f,
        length: 4096,
        data: [new Float32Array(4096).fill(0.1), new Float32Array(4096).fill(-0.1)],
      });
      m.addChunk(1, 1, {
        lap: 0,
        frame: f,
        length: 4096,
        data: [new Float32Array(4096).fill(0.2)],
      });
    }
    m.play();
    const b0 = new Float32Array(128);
    const b1 = new Float32Array(128);
    const run = (blocks: number) => {
      for (let i = 0; i < blocks; i++) m.mixBlock(b0, b1, 128, 1);
    };
    // Warm up the JIT on every path measured below (gain ramps included): a first-time branch
    // runs deoptimized for a while, which allocates heap numbers in V8 itself.
    for (let i = 0; i < 20; i++) {
      m.setTrack(0, { gainDb: i % 2 ? -10 : -3 });
      run(1000);
    }
    m.setTrack(0, { gainDb: -6 });

    const session = new Session();
    session.connect();
    await session.post("HeapProfiler.startSampling", {
      samplingInterval: 16,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(3000);
    const { profile } = await session.post("HeapProfiler.stopSampling");
    session.disconnect();

    const where: string[] = [];
    const bytes = mixerBytes(profile.head, where);
    expect(bytes, where.join(", ")).toBeLessThan(4096);
    expect(m.position.state).toBe("playing");
    // One preallocated report object, reused (the worklet's postMessage copies it).
    expect(reports.size).toBe(1);
  });
});
