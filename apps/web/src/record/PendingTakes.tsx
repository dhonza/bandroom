import { ActionIcon, Button, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconMicrophone, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PendingTake } from "../offline/db";
import { formatBytes } from "../lib/media";
import { useOnline } from "../offline/online";
import { useUploadErrorText } from "../upload/UploadRow";
import { formatTakeTime } from "./model";
import { discardPendingTake, uploadTake, useTakes } from "./takes";

/**
 * A saved take waiting for its upload (SPEC §9): offline it waits for the network; a refused
 * upload shows why. Retry and Discard (confirmed). While it uploads, the upload row shows it.
 */
export function PendingTakeRow({ take }: { take: PendingTake }) {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const errorText = useUploadErrorText();
  const [confirm, setConfirm] = useState(false);
  const size = formatBytes(take.bytes, i18n.resolvedLanguage ?? "en");
  const status =
    take.status === "error"
      ? errorText(take.errorCode, null)
      : online
        ? t("record.pending.notSent")
        : t("record.pending.waiting");
  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      data-testid="pending-take"
      data-status={take.status}
      data-take={take.takeId}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <IconMicrophone size={18} aria-hidden style={{ flex: "none" }} />
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {take.title}
            </Text>
            <Text size="xs" c={take.status === "error" ? "red" : "dimmed"}>
              {[formatTakeTime(take.frames), size, status].join(" · ")}
            </Text>
          </Stack>
        </Group>
        {confirm ? (
          <Group gap={4} wrap="nowrap">
            <Button
              variant="default"
              h={44}
              size="compact-sm"
              onClick={() => {
                setConfirm(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              color="red"
              h={44}
              size="compact-sm"
              onClick={() => {
                void discardPendingTake(take.takeId);
              }}
              data-testid="pending-take-discard-confirm"
            >
              {t("record.discard")}
            </Button>
          </Group>
        ) : (
          <Group gap={0} wrap="nowrap">
            {online && (
              <Tooltip label={t("common.retry")}>
                <ActionIcon
                  variant="subtle"
                  size={44}
                  aria-label={t("common.retry")}
                  onClick={() => {
                    void uploadTake(take.takeId);
                  }}
                  data-testid="pending-take-retry"
                >
                  <IconRefresh size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label={t("record.discard")}>
              <ActionIcon
                variant="subtle"
                color="red"
                size={44}
                aria-label={t("record.discard")}
                onClick={() => {
                  setConfirm(true);
                }}
                data-testid="pending-take-discard"
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
    </Paper>
  );
}

/** Saved takes not uploaded yet, of one song (its track list) or all of them (Offline page). */
export function PendingTakes({ songId }: { songId?: string }) {
  const all = useTakes((s) => s.pending);
  const takes = useMemo(
    () =>
      all.filter((p) => p.status !== "uploading" && (songId === undefined || p.songId === songId)),
    [all, songId],
  );
  if (takes.length === 0) return null;
  return (
    <Stack gap="xs" data-testid="pending-takes">
      {takes.map((p) => (
        <PendingTakeRow key={p.takeId} take={p} />
      ))}
    </Stack>
  );
}
