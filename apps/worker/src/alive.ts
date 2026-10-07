import fs from "node:fs/promises";

/**
 * Keeps a liveness file fresh for the container health check (deploy/compose.yml), which only
 * compares the file's age with `find -mmin` instead of starting a Node process. A timer, not the
 * job loop, refreshes it, so a long ffmpeg job does not look like a dead worker; it proves the
 * process and its event loop are alive. Disabled when `file` is empty.
 */
export function startAliveFile(
  file: string | undefined,
  onError: (err: unknown) => void,
  intervalMs = 30_000,
): () => void {
  if (!file) return () => undefined;
  const touch = () => {
    fs.writeFile(file, `${String(Date.now())}\n`).catch(onError);
  };
  touch();
  const timer = setInterval(touch, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
