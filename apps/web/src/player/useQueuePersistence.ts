import { useEffect } from "react";
import { isLinkMode } from "../links/linkMode";
import { restoreQueue, useRehearse, type RehearseState } from "../rehearse/controller";
import { loadSavedQueue, saveQueue, setQueueStorageUser } from "./queueStorage";
import { useQueueLoader } from "./useProjectQueue";

/**
 * A queue is worth keeping once it is more than a song page's own song, or once it played (a
 * song only looked at is not brought back after a reload).
 */
function worthSaving(s: RehearseState): boolean {
  if (!s.queue) return false;
  return s.queue.source.kind !== "song" || s.dormant || s.status === "playing";
}

/**
 * Keeps the play queue on this device per user (SPEC §6.10): saved whenever it or the repeat
 * mode changes, restored paused when the app starts with nothing open. The app shell calls it;
 * public links keep nothing.
 */
export function useQueuePersistence(userId: string): void {
  const loader = useQueueLoader();
  useEffect(() => {
    if (isLinkMode()) return;
    setQueueStorageUser(userId);
    const s = useRehearse.getState();
    if (!s.open && !s.queue) {
      const saved = loadSavedQueue();
      if (saved) restoreQueue(saved.queue, saved.repeat, loader);
    }
    const unsubscribe = useRehearse.subscribe((st, prev) => {
      const changed =
        st.queue !== prev.queue ||
        st.repeat !== prev.repeat ||
        (st.status === "playing" && prev.status !== "playing");
      if (changed && st.queue && worthSaving(st)) saveQueue({ queue: st.queue, repeat: st.repeat });
    });
    return () => {
      unsubscribe();
      setQueueStorageUser(null);
    };
  }, [userId, loader]);
}
