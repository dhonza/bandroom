/** Player readout "0:49.312" (SPEC §12: m:ss.mmm). */
export function formatClock(sec: number, withMs = true): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  if (!withMs) return `${m}:${String(Math.floor(rest)).padStart(2, "0")}`;
  const whole = Math.floor(rest);
  const ms = Math.floor((rest - whole) * 1000);
  return `${m}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Parses "1:23.456", "83.456" or "0:01:23" into seconds; null when it is not a time. */
export function parseClock(text: string): number | null {
  const s = text.trim().replace(",", ".");
  if (!/^\d+(:\d{1,2})*(\.\d+)?$/.test(s)) return null;
  const parts = s.split(":").map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Number.isFinite(sec) ? sec : null;
}
