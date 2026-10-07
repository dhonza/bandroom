/** Uploads running at once in the browser (SPEC §28.1); the others wait in FIFO order. */
export const MAX_CONCURRENT_UPLOADS = 3;

/** A place in the upload queue: `ready` resolves when the upload may start. */
export interface UploadSlot {
  ready: Promise<void>;
  /** Frees the slot (or leaves the queue while still waiting). Safe to call more than once. */
  release: () => void;
}

/** A FIFO semaphore for uploads. */
export function createUploadQueue(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  const next = () => {
    while (running < max && waiting.length > 0) {
      const grant = waiting.shift();
      if (grant) {
        running++;
        grant();
      }
    }
  };

  return {
    acquire(): UploadSlot {
      let state: "waiting" | "running" | "released" = "waiting";
      let grant: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        grant = () => {
          state = "running";
          resolve();
        };
      });
      waiting.push(grant);
      next();
      return {
        ready,
        release: () => {
          if (state === "released") return;
          if (state === "running") running--;
          else {
            const i = waiting.indexOf(grant);
            if (i >= 0) waiting.splice(i, 1);
          }
          state = "released";
          next();
        },
      };
    },
    /** Uploads running and waiting (for tests). */
    stats: () => ({ running, waiting: waiting.length }),
  };
}

/** The app-wide upload queue. */
export const uploadQueue = createUploadQueue(MAX_CONCURRENT_UPLOADS);
