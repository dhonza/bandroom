import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streams a file through SHA-256 (never loads it into memory, SPEC §19.6). */
export async function sha256File(filePath: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) h.update(chunk as Buffer);
  return h.digest("hex");
}
