import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { projectKeys, songKeys } from "../features/library/queries";
import { trashKeys } from "../trash/queries";
import type { ApplyResult } from "./editSync";

const TOAST_ID = "edit-finished";

/**
 * After the commit of an Apply/Bounce (SPEC §24.8, §24.9): the song reloads with its new
 * versions and remapped timeline, the Trash shows the replaced versions, and a toast says what
 * was made ("Created 2 songs" with "Open project").
 */
export function useFinishedEdit(songId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useCallback(
    (result: ApplyResult | null) => {
      // Tracks, versions, markers, comments, tempo and the song itself.
      void qc.invalidateQueries({ queryKey: songKeys.detail(songId) });
      void qc.invalidateQueries({ queryKey: trashKeys.all });
      const projectId = qc.getQueryData<{ song: { project: { id: string } } }>(
        songKeys.detail(songId),
      )?.song.project.id;
      if (projectId) void qc.invalidateQueries({ queryKey: projectKeys.songs(projectId) });
      if (!result) {
        notifications.show({ id: TOAST_ID, color: "green", message: t("edit.finished.generic") });
        return;
      }
      const message = t(`edit.finished.${result.kind}`, { count: result.count });
      const open = result.kind === "bounceSongs" && projectId;
      notifications.show({
        id: TOAST_ID,
        color: "green",
        autoClose: open ? 12_000 : 6000,
        message: open ? (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm" data-testid="edit-finished">
              {message}
            </Text>
            <Button
              size="sm"
              variant="light"
              h={44}
              onClick={() => {
                notifications.hide(TOAST_ID);
                void navigate(`/projects/${projectId}`);
              }}
              data-testid="edit-open-project"
            >
              {t("edit.finished.openProject")}
            </Button>
          </Group>
        ) : (
          <span data-testid="edit-finished">{message}</span>
        ),
      });
    },
    [qc, songId, t, navigate],
  );
}
