import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Creates a temp directory and returns it with a cleanup function (for tests). */
export function makeTempDir(prefix = "bandroom-test-"): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
