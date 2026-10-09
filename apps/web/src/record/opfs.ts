import { takeFileName, takeMetaName } from "./takeTypes";

/**
 * Take files in the origin private file system (SPEC §9): `takes/<userId>/<takeId>.flac` and
 * its sidecar. The take writer worker writes them; the main thread reads a take for its upload
 * and removes takes.
 */

const ROOT = "takes";

/**
 * OPFS and workers (the take writer, SPEC §9). Synchronous access handles exist only inside
 * workers: a browser without them reports a failed take writer when recording starts.
 */
export function recordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

/** The user's take folder; null when it does not exist (and `create` is false). */
export async function userTakeDir(
  userId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const takes = await root.getDirectoryHandle(ROOT, { create });
    return await takes.getDirectoryHandle(userId, { create });
  } catch {
    return null;
  }
}

/** The recorded FLAC file of a take, or null when it is gone. */
export async function takeFile(userId: string, takeId: string): Promise<File | null> {
  const dir = await userTakeDir(userId, false);
  if (!dir) return null;
  try {
    return await (await dir.getFileHandle(takeFileName(takeId))).getFile();
  } catch {
    return null;
  }
}

/** Removes a take's file and sidecar. */
export async function removeTakeFiles(userId: string, takeId: string): Promise<void> {
  const dir = await userTakeDir(userId, false);
  if (!dir) return;
  for (const name of [takeFileName(takeId), takeMetaName(takeId)]) {
    await dir.removeEntry(name).catch(() => undefined);
  }
}

/** Removes all of a user's takes (logout, SPEC §13). */
export async function removeUserTakes(userId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const takes = await root.getDirectoryHandle(ROOT);
    await takes.removeEntry(userId, { recursive: true });
  } catch {
    // nothing there
  }
}
