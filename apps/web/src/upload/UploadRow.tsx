import { ActionIcon, Group, Paper, Progress, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/client";
import { useApiError } from "../api/useApiError";
import { formatBytes } from "../lib/media";
import { uploadFailure } from "./startUpload";
import { useUploads, type UploadItem } from "./uploadStore";

/** Uploads that create documents or document versions (shown with the documents, not tracks). */
export function isDocumentUpload(item: UploadItem): boolean {
  return item.target.type === "newDocument" || item.target.type === "documentVersion";
}

/** Translates an upload/server error code (with params such as remaining quota). */
export function useUploadErrorText() {
  const { t, i18n } = useTranslation();
  const apiError = useApiError();
  return (code: string | null, params: Record<string, string | number> | null) => {
    if (code === "QUOTA_EXCEEDED") {
      return t("tracks.errors.quota", {
        remaining: formatBytes(Number(params?.remainingBytes ?? 0), i18n.resolvedLanguage ?? "en"),
        admins: String(params?.admins ?? ""),
      });
    }
    return apiError(new ApiError(0, { code: code ?? "UNKNOWN", message: "" }));
  };
}

/**
 * Reports a rejected upload as a red toast (titled with the file name); a cancelled upload is not
 * an error and is not reported.
 */
export function useUploadErrorToast() {
  const errorText = useUploadErrorText();
  return (err: unknown, title?: string) => {
    const f = uploadFailure(err);
    if (f) notifications.show({ color: "red", title, message: errorText(f.code, f.params) });
  };
}

/** One running or failed upload with progress and cancel. */
export function UploadRow({
  item,
  errorText,
}: {
  item: UploadItem;
  errorText: (c: string | null, p: Record<string, string | number> | null) => string;
}) {
  const { t, i18n } = useTranslation();
  const remove = useUploads((s) => s.remove);
  const active = item.status === "uploading" || item.status === "queued";
  return (
    <Paper withBorder radius="md" p="sm" data-testid="upload-row" data-status={item.status}>
      <Group justify="space-between" wrap="nowrap">
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>
            {item.filename}
          </Text>
          {item.status === "error" ? (
            <Text size="xs" c="red">
              {errorText(item.errorCode, item.errorParams)}
            </Text>
          ) : (
            <>
              <Progress
                value={item.progress * 100}
                size="sm"
                animated={item.status === "uploading"}
              />
              <Text size="xs" c="dimmed">
                {item.status === "queued"
                  ? t("tracks.uploadQueued", {
                      size: formatBytes(item.size, i18n.resolvedLanguage ?? "en"),
                    })
                  : t("tracks.uploading", {
                      percent: Math.round(item.progress * 100),
                      size: formatBytes(item.size, i18n.resolvedLanguage ?? "en"),
                    })}
              </Text>
            </>
          )}
        </Stack>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label={active ? t("tracks.cancelUpload") : t("common.close")}
          onClick={() => {
            if (active) item.abort?.();
            remove(item.id);
          }}
        >
          <IconX size={18} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}
