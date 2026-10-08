import type { Track } from "@bandroom/shared";
import { Button, Group, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MatchProposal } from "../../lib/media";
import { UploadSettings } from "../../upload/UploadSettings";
import { AppModal } from "../../components/ResponsivePanel";

const NEW = "__new";

/**
 * Confirms where dropped files go (SPEC §5.1): each file becomes a new version of a matched track
 * or a new track. The user can change every proposal before uploading.
 */
export function MatchDialog({
  proposals,
  tracks,
  onConfirm,
  onClose,
}: {
  proposals: MatchProposal[];
  tracks: Track[];
  onConfirm: (result: MatchProposal[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(proposals);
  return (
    <AppModal opened onClose={onClose} title={t("tracks.match.title")} size="lg" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          {t("tracks.match.explain")}
        </Text>
        {rows.map((r, i) => (
          <Group key={r.file} justify="space-between" wrap="wrap" gap="xs" data-testid="match-row">
            <Text size="sm" fw={500} style={{ flex: "1 1 200px", minWidth: 0 }} truncate>
              {r.file}
            </Text>
            <Select
              w={260}
              aria-label={t("tracks.match.target", { file: r.file })}
              allowDeselect={false}
              value={r.trackId ?? NEW}
              data={[
                { value: NEW, label: t("tracks.match.newTrack", { name: r.newName }) },
                ...tracks.map((tr) => ({
                  value: tr.id,
                  label: t("tracks.match.newVersionOf", { name: tr.name }),
                })),
              ]}
              onChange={(v) => {
                setRows((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, trackId: v === NEW || v === null ? null : v } : x,
                  ),
                );
              }}
            />
          </Group>
        ))}
        <Group justify="space-between" gap="xs">
          <UploadSettings testId="match-upload-settings" />
          <Group gap="xs" justify="flex-end" style={{ flex: 1 }}>
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                onConfirm(rows);
              }}
              data-testid="match-confirm"
            >
              {t("tracks.match.upload", { count: rows.length })}
            </Button>
          </Group>
        </Group>
      </Stack>
    </AppModal>
  );
}
