import { PALETTE_COLORS, type PaletteColor } from "@bandroom/shared";

/** Nearest palette color for a Samply hex color (by hue); defaults to violet. */
export function paletteFromHex(hex: string | null | undefined): PaletteColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m?.[1]) return "violet";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 0.08) return "violet"; // grey: no hue to match
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const deg = h * 60;
  const hues: [PaletteColor, number][] = [
    ["red", 0],
    ["orange", 30],
    ["gold", 45],
    ["yellow", 55],
    ["lime", 85],
    ["green", 125],
    ["mint", 150],
    ["teal", 170],
    ["cyan", 190],
    ["blue", 210],
    ["indigo", 235],
    ["violet", 260],
    ["grape", 290],
    ["pink", 320],
    ["red", 360],
  ];
  let best: PaletteColor = "violet";
  let bestD = Infinity;
  for (const [c, hue] of hues) {
    const dist = Math.abs(deg - hue);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return PALETTE_COLORS.includes(best) ? best : "violet";
}

/**
 * Runs `worker` over `items` with up to `concurrency` in flight, but hands results to `commit` in
 * list order (downloads overlap; version numbers still follow the stack order).
 */
export async function orderedPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  commit: (item: T, result: PromiseSettledResult<R>) => Promise<void> | void,
): Promise<void> {
  const inFlight: Promise<PromiseSettledResult<R>>[] = [];
  let next = 0;
  const start = () => {
    const item = items[next++] as T;
    inFlight.push(
      worker(item).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      ),
    );
  };
  while (next < items.length && inFlight.length < concurrency) start();
  for (let i = 0; i < items.length; i++) {
    const result = await (inFlight[i] as Promise<PromiseSettledResult<R>>);
    if (next < items.length) start();
    await commit(items[i] as T, result);
  }
}
