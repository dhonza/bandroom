import fs from "node:fs/promises";

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

/** Disk usage of the filesystem holding `dir` (free = available to unprivileged users). */
export async function diskUsage(dir: string): Promise<DiskUsage> {
  const s = await fs.statfs(dir);
  return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
}
