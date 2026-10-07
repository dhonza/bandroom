import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startAliveFile } from "./alive";

describe("startAliveFile", () => {
  it("does nothing without a file", () => {
    const onError = vi.fn();
    const stop = startAliveFile(undefined, onError);
    stop();
    expect(onError).not.toHaveBeenCalled();
  });

  it("writes the file at once and keeps refreshing it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alive-"));
    const file = path.join(dir, "worker-alive");
    const stop = startAliveFile(file, () => undefined, 20);
    let first = 0;
    await vi.waitFor(async () => {
      first = Number(await fs.readFile(file, "utf8"));
      expect(first).toBeGreaterThan(0);
    });
    await vi.waitFor(async () => {
      expect(Number(await fs.readFile(file, "utf8"))).toBeGreaterThan(first);
    });
    stop();
    await fs.rm(dir, { recursive: true });
  });

  it("reports write errors instead of throwing", async () => {
    const onError = vi.fn();
    const stop = startAliveFile("/nonexistent-dir/alive", onError, 1_000_000);
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    stop();
  });
});
