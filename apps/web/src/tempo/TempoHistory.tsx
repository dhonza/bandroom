import type { Song, SongTempo } from "@bandroom/shared";
import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { tempoSummaryParams } from "./midi";
import { summarize } from "./model";
import { useTempoActions, useTempoRevisions } from "./queries";
import { BTN } from "./styles";

/** Earlier tempo maps of the song, each restorable. */
export function TempoHistory({ song, tempo }: { song: Song; tempo: SongTempo | null }) {
  const { t, i18n } = useTranslation();
  const apiError = useApiError();
  const actions = useTempoActions(song.id);
  const q = useTempoRevisions(song.id, true);
  const [busy, setBusy] = useState<string | null>(null);
  const revisions = q.data?.revisions ?? [];
  if (q.isPending) return <Text c="dimmed">{t("common.loading")}</Text>;
  if (revisions.length === 0) return <Text c="dimmed">{t("tempo.history.empty")}</Text>;
  return (
    <Stack gap="xs" data-testid="tempo-history">
      {revisions.map((r) => {
        const s = summarize(r.map);
        const current = tempo?.revisionId === r.id;
        return (
          <Group
            key={r.id}
            justify="space-between"
            wrap="nowrap"
            data-testid="tempo-revision"
            style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
            pb={6}
          >
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} truncate>
                {t("tempo.summary", tempoSummaryParams(s))}
                {s.changes > 0 ? ` · ${t("tempo.midi.changes", { count: s.changes })}` : ""}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {r.source === "midi"
                  ? t("tempo.history.midi", { file: r.midiFileName ?? "MIDI" })
                  : t("tempo.history.manual")}
                {" · "}
                {new Date(r.createdAt).toLocaleString(i18n.language)}
                {r.createdByName ? ` · ${r.createdByName}` : ""}
              </Text>
            </Stack>
            {current ? (
              <Badge variant="light">{t("tempo.history.current")}</Badge>
            ) : (
              <Button
                {...BTN}
                size="xs"
                variant="default"
                loading={busy === r.id}
                onClick={() => {
                  setBusy(r.id);
                  actions
                    .restore(r.id)
                    .then(() => {
                      notifications.show({ message: t("tempo.history.restored") });
                    })
                    .catch((err: unknown) => {
                      notifications.show({ color: "red", message: apiError(err) });
                    })
                    .finally(() => {
                      setBusy(null);
                    });
                }}
                data-testid="tempo-restore"
              >
                {t("tempo.history.restore")}
              </Button>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}
