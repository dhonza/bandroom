import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { prepareDroppedFiles, type PathFile } from "../lib/media";
import { isZipFile } from "../lib/zip";

/** Zips above this size get a memory warning: their entries are held until uploaded. */
const LARGE_ZIP_BYTES = 1024 ** 3;

/**
 * Prepares dropped or picked files with feedback (SPEC §28.1): a "Unpacking…" toast while zips
 * are unpacked, a warning for very large zips, and toasts for broken zips and skipped files.
 */
export function usePrepareFiles() {
  const { t } = useTranslation();
  return async (
    files: readonly PathFile[],
    mode: "project" | "song",
    picked = false,
  ): Promise<PathFile[]> => {
    const zips = files.filter(isZipFile);
    if (zips.some((z) => z.size > LARGE_ZIP_BYTES))
      notifications.show({ color: "yellow", message: t("tracks.zipLarge") });
    const id = zips.length > 0 ? `unzip-${Date.now()}` : null;
    if (id)
      notifications.show({ id, loading: true, autoClose: false, message: t("tracks.unpacking") });
    try {
      const { files: out, skipped, failedZips } = await prepareDroppedFiles(files, mode, picked);
      for (const name of failedZips)
        notifications.show({ color: "red", message: t("tracks.zipFailed", { name }) });
      if (skipped > 0)
        notifications.show({ color: "yellow", message: t("tracks.skippedNonAudio") });
      return out;
    } finally {
      if (id) notifications.hide(id);
    }
  };
}
