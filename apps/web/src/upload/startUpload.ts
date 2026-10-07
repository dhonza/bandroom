import {
  ApiErrorSchema,
  UploadResultSchema,
  type UploadResult,
  type UploadTarget,
} from "@bandroom/shared";
import * as tus from "tus-js-client";
import { apiUrl } from "../lib/media";
import { isOnline } from "../offline/online";
import { uploadQueue } from "./uploadQueue";
import { useUploads } from "./uploadStore";

const CHUNK_SIZE = 8 * 1024 * 1024; // SPEC §5.1

/** Back-off between retries; a `Retry-After` stretches the current delay (SPEC §28.1). */
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10_000, 30_000, 60_000, 60_000];
const MAX_RETRY_DELAY = 60_000;

/**
 * Whether tus should retry a failed request: network failures, `429` (the upload-creation rate
 * limit), `5xx`, and tus's own `409`/`423` conflicts, while online. A `429`'s `Retry-After`
 * (seconds) becomes this attempt's delay, capped at a minute.
 */
export function shouldRetryUpload(
  err: tus.DetailedError,
  attempt: number,
  options: { retryDelays?: number[] | null },
): boolean {
  if (!isOnline()) return false;
  const res = err.originalResponse;
  const status = res ? res.getStatus() : 0;
  const retry = status === 0 || status === 429 || status >= 500 || status === 409 || status === 423;
  if (!retry) return false;
  const after = status === 429 ? Number(res?.getHeader("Retry-After")) : NaN;
  const delays = options.retryDelays;
  if (delays && Number.isFinite(after) && after > 0 && attempt < delays.length) {
    delays[attempt] = Math.min(MAX_RETRY_DELAY, Math.max(delays[attempt] ?? 0, after * 1000));
  }
  return true;
}

function parseTusError(err: Error): {
  code: string;
  params: Record<string, string | number> | null;
} {
  const res = (err as tus.DetailedError).originalResponse;
  const body = res?.getBody();
  if (body) {
    try {
      const parsed = ApiErrorSchema.safeParse(JSON.parse(body));
      if (parsed.success) return { code: parsed.data.code, params: parsed.data.params ?? null };
    } catch {
      // not JSON
    }
  }
  return { code: res ? "UNKNOWN" : "NETWORK", params: null };
}

/** Error code an upload rejects with when the user cancels it; callers do not report it. */
export const UPLOAD_CANCELLED = "CANCELLED";

/** A rejected upload: the server's (or client's) error code with its params. */
export interface UploadFailure {
  code: string;
  params: Record<string, string | number> | null;
}

function failure(code: string, params: Record<string, string | number> | null = null): Error {
  return Object.assign(new Error(code), { code, params });
}

/** The code and params of an upload rejection, or `null` when the user cancelled it. */
export function uploadFailure(err: unknown): UploadFailure | null {
  const e = (err ?? {}) as { code?: unknown; params?: unknown };
  const code = typeof e.code === "string" ? e.code : "UNKNOWN";
  if (code === UPLOAD_CANCELLED) return null;
  const params =
    e.params && typeof e.params === "object" ? (e.params as Record<string, string | number>) : null;
  return { code, params };
}

function parseResult(body: string): UploadResult | null {
  try {
    const parsed = UploadResultSchema.safeParse(JSON.parse(body || "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Starts a resumable tus upload (SPEC §5.1) and tracks it in the upload store. Resolves with the
 * server's result (new asset/track/version ids) or rejects with `{ code, params }` — the code is
 * {@link UPLOAD_CANCELLED} when the user cancels. A finished upload leaves the store; a failed one
 * stays (as an error row) until dismissed. At most three run at once ({@link uploadQueue}); the
 * others wait as `queued` rows (SPEC §28.1).
 */
export function startUpload(
  file: File,
  target: UploadTarget,
  scope: { songId: string | null; projectId: string | null },
): Promise<UploadResult> {
  // Uploads need the network (SPEC §13); nothing is queued offline.
  if (!isOnline()) return Promise.reject(failure("NETWORK"));
  const store = useUploads.getState();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const slot = uploadQueue.acquire();
    const fail = (code: string, params: Record<string, string | number> | null = null) => {
      if (settled) return;
      settled = true;
      slot.release();
      if (code === UPLOAD_CANCELLED) store.remove(id);
      else store.update(id, { status: "error", errorCode: code, errorParams: params });
      reject(failure(code, params));
    };
    const upload = new tus.Upload(file, {
      endpoint: apiUrl("/uploads"),
      chunkSize: CHUNK_SIZE,
      // A copy per upload: a Retry-After adjusts it in place.
      retryDelays: [...RETRY_DELAYS],
      onShouldRetry: shouldRetryUpload,
      headers: { "X-Requested-With": "bandroom" },
      metadata: { filename: file.name, target: JSON.stringify(target) },
      removeFingerprintOnSuccess: true,
      onProgress: (sent, total) => {
        if (!settled) store.update(id, { progress: total ? sent / total : 0 });
      },
      onError: (err) => {
        const { code, params } = parseTusError(err);
        fail(code, params);
      },
      onSuccess: (payload) => {
        const result = parseResult(payload.lastResponse.getBody());
        if (!result) {
          fail("UNKNOWN");
          return;
        }
        settled = true;
        slot.release();
        store.remove(id);
        resolve(result);
      },
      // Do not resume a finished upload's fingerprint for a different target.
      fingerprint: (f) =>
        Promise.resolve(`bandroom-${JSON.stringify(target)}-${f.name}-${f.size}-${f.lastModified}`),
    });
    store.add({
      id,
      filename: file.name,
      size: file.size,
      target,
      songId: scope.songId,
      projectId: scope.projectId,
      progress: 0,
      status: "queued",
      errorCode: null,
      errorParams: null,
      abort: () => {
        void upload.abort(true).catch(() => undefined);
        fail(UPLOAD_CANCELLED);
      },
    });
    // A failed lookup of a resumable upload (e.g. storage blocked) just starts afresh.
    void slot.ready
      .then(() => {
        if (settled) return [];
        store.update(id, { status: "uploading" });
        return upload.findPreviousUploads();
      })
      .catch(() => [])
      .then((previous) => {
        if (settled) return;
        const [last] = previous;
        if (last) upload.resumeFromPreviousUpload(last);
        upload.start();
      });
  });
}
