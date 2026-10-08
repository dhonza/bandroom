// CPU benchmark: seconds of CPU per second of audio per channel, per profile/quality/rate.
// Run: pnpm --filter @bandroom/stretch bench   (indicative only on a loaded machine)
import { createStretch } from "../src/create";
import { loadStretch } from "../src/node";
import type { StretchProfile, StretchQuality } from "../src/profiles";

const SECONDS = 20;
const SR = 48_000;
const mod = await loadStretch();
const n = SECONDS * SR;
const sig = new Float32Array(n);
let seed = 1;
for (let i = 0; i < n; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  sig[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.05 * (seed / 0x7fffffff - 0.5);
}

const rows: string[] = [];
for (const quality of ["high", "economy"] as StretchQuality[]) {
  for (const profile of ["tonal", "percussive"] as StretchProfile[]) {
    for (const [rate, semitones] of [
      [1, -2],
      [0.75, 0],
      [0.5, 0],
      [0.75, -2],
    ] as const) {
      const s = createStretch(mod, {
        channels: 2,
        rate,
        semitones,
        profile,
        quality,
        voiceBaseHz: 0,
      });
      s.begin(0);
      const t0 = performance.now();
      for (let p = 0; p < n; p += 4096) s.push([sig, sig], p, Math.min(4096, n - p));
      const ms = performance.now() - t0;
      s.dispose();
      const perChannel = ms / 1000 / (SECONDS * 2);
      rows.push(
        `${quality.padEnd(8)} ${profile.padEnd(11)} rate ${rate.toFixed(2)} st ${String(semitones).padStart(3)}: ` +
          `${(perChannel * 100).toFixed(2)} % of a core per channel (input seconds)`,
      );
    }
  }
}
console.log(rows.join("\n"));
