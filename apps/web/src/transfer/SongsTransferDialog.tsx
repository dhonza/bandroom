import { batchCopySongs, batchMoveSongs } from "@bandroom/shared";
import { Alert, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { useInvalidateBatch } from "../trash/queries";
import { NEW_PROJECT, targetBody } from "./targets";
import { TargetPicker } from "./TargetPicker";
import { AppModal } from "../components/ResponsivePanel";

/** What the copy/move dialog is opened for (SPEC §26.6). */
export interface SongsTransferRequest {
  songs: string[];
  mode: "copy" | "move";
  /** The songs' project. */
  projectId: string;
  /** "New project from selection": preselects a new project. */
  newProject: boolean;
  /** Whether the user may move these songs (managers); otherwise only Copy is offered. */
  canMove: boolean;
}

/**
 * Copy or move songs to another project, or to a new one (SPEC §26.6). Copies share the stored
 * files; a move drops song-specific access. Opens the target project afterwards.
 */
export function SongsTransferDialog({
  request,
  onClose,
  onDone,
}: {
  request: SongsTransferRequest | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppModal
      opened={request !== null}
      onClose={onClose}
      title={request?.newProject ? t("transfer.newProjectTitle") : t("transfer.songsTitle")}
      centered
    >
      {request && <Body request={request} onClose={onClose} onDone={onDone} />}
    </AppModal>
  );
}

function Body({
  request,
  onClose,
  onDone,
}: {
  request: SongsTransferRequest;
  onClose: () => void;
  onDone: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateBatch();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"copy" | "move">(request.canMove ? request.mode : "copy");
  const [target, setTarget] = useState<string | null>(request.newProject ? NEW_PROJECT : null);
  const [newName, setNewName] = useState("");
  const apply = useMutation({
    mutationFn: () => {
      const body = { songs: request.songs, ...targetBody(target ?? "", newName) };
      return mode === "copy" ? api(batchCopySongs, { body }) : api(batchMoveSongs, { body });
    },
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        message:
          mode === "copy"
            ? t("transfer.songsCopied", { count: r.count })
            : t("transfer.songsMoved", { count: r.count }),
      });
      onDone?.();
      onClose();
      void navigate(`/projects/${r.projectId}`);
    },
  });
  const ready = target !== null && (target !== NEW_PROJECT || newName.trim().length > 0);
  return (
    <Stack gap="sm" data-testid="songs-transfer-dialog">
      {request.canMove && (
        <Radio.Group
          value={mode}
          onChange={(v) => {
            setMode(v === "move" ? "move" : "copy");
            // Moving within the song's own project does nothing.
            if (v === "move" && target === request.projectId) setTarget(null);
          }}
          data-testid="transfer-mode"
        >
          <Group gap="lg" mih={44}>
            <Radio value="copy" label={t("transfer.modeCopy")} />
            <Radio value="move" label={t("transfer.modeMove")} />
          </Group>
        </Radio.Group>
      )}
      <Text size="sm">
        {mode === "copy"
          ? t("transfer.copyExplain", { count: request.songs.length })
          : t("transfer.moveExplain", { count: request.songs.length })}
      </Text>
      <TargetPicker
        value={target}
        onChange={setTarget}
        newName={newName}
        onNewName={setNewName}
        {...(mode === "move" && { exclude: request.projectId })}
      />
      {apply.isError && <Alert color="red">{apiError(apply.error)}</Alert>}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" h={44} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          h={44}
          disabled={!ready}
          loading={apply.isPending}
          onClick={() => {
            apply.mutate();
          }}
          data-testid="songs-transfer-submit"
        >
          {mode === "copy" ? t("transfer.copy") : t("transfer.move")}
        </Button>
      </Group>
    </Stack>
  );
}
