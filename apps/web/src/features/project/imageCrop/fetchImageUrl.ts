import { ApiErrorSchema, PROJECT_IMAGE_FETCH_PATH } from "@bandroom/shared";
import { ApiError, contractUrl } from "../../../api/client";

/**
 * Asks the server to fetch an image URL for the crop dialog (SPEC §25.4). The answer is the
 * image itself; refusals come back as API errors (`IMAGE_URL_*`).
 */
export async function fetchImageUrl(
  projectId: string,
  url: string,
  signal?: AbortSignal,
): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(
      contractUrl({ path: PROJECT_IMAGE_FETCH_PATH }, { params: { id: projectId } }),
      {
        method: "POST",
        headers: {
          Accept: "image/*, application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "bandroom",
        },
        credentials: "same-origin",
        body: JSON.stringify({ url }),
        ...(signal && { signal }),
      },
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, { code: "NETWORK", message: String(err) });
  }
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => undefined));
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data : { code: "UNKNOWN", message: `HTTP ${String(res.status)}` },
    );
  }
  try {
    return await res.blob();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // The transfer was cut short (size cap or timeout after the first bytes).
    throw new ApiError(502, { code: "IMAGE_URL_FAILED", message: String(err) });
  }
}
