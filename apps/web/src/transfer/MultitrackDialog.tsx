import {
  batchCopyTracks,
  batchMakeMultitrack,
  batchMultitrackPreview,
  type MultitrackItems,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { formatDuration } from "../lib/media";
import { useInvalidateBatch } from "../trash/queries";
import { NEW_PROJECT, targetBody } from "./targets";
import { TargetPicker } from "./TargetPicker";
import { AppModal } from "../components/ResponsivePanel";

/** What the multitrack dialog is opened for (SPEC §26.5, §26.6). */
export interface MultitrackRequest {
  items: MultitrackItems;
  /** `move`: make multitrack song / move tracks; `copy`: copy tracks into a new song. */
  mode: "move" | "copy";
  /** The preselected target project (the current one), null to make the user pick. */
  projectId: string | null;
}

/**
 * Make a multitrack song, or copy/move tracks to a project as a new song: the tracks with their
 * lengths, a length warning (never a block), what goes to the Trash, the song name (prefilled
 * from the source names) and the target project. Opens the new song afterwards.
 */
export function MultitrackDialog({
  request,
  onClose,
  onDone,
}: {
  request: MultitrackRequest | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const title =
    request?.mode === "copy"
      ? t("transfer.copyTracksTitle")
      : request?.projectId
        ? t("transfer.multitrackTitle")
        : t("transfer.moveTracksTitle");
  return (
    <AppModal opened={request !== null} onClose={onClose} title={title} centered>
      {request && <Body request={request} onClose={onClose} onDone={onDone} />}
    </AppModal>
  );
}

function Body({
  request,
  onClose,
  onDone,
}: {
  request: MultitrackRequest;
  onClose: () => void;
  onDone: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateBatch();
  const navigate = useNavigate();
  const [name, setName] = useState<string | null>(null);
  /** Track names edited in the table, per source track id (the rest keep the preview's). */
  const [names, setNames] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<string | null>(request.projectId);
  const [newName, setNewName] = useState("");
  const preview = useQuery({
    queryKey: ["batch", "multitrack-preview", request.items],
    queryFn: ({ signal }) => api(batchMultitrackPreview, { body: request.items }, { signal }),
    gcTime: 0,
    staleTime: 0,
  });
  const songName = name ?? preview.data?.suggestedName ?? "";
  const apply = useMutation({
    mutationFn: () => {
      const edited = Object.fromEntries(
        Object.entries(names).map(([id, n]) => [id, n.trim()] as const),
      );
      const body = {
        ...request.items,
        name: songName.trim(),
        ...(Object.keys(edited).length > 0 && { names: edited }),
        ...targetBody(target ?? "", newName),
      };
      return request.mode === "copy"
        ? api(batchCopyTracks, { body })
        : api(batchMakeMultitrack, { body });
    },
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        message:
          request.mode === "copy"
            ? t("transfer.tracksCopied")
            : emptied > 0
              ? t("transfer.madeWithTrash", { count: emptied })
              : t("transfer.made"),
      });
      onDone?.();
      onClose();
      const songId = r.songIds[0];
      if (songId) void navigate(`/songs/${songId}`);
    },
  });
  if (preview.isPending) return <Loader />;
  if (preview.isError) return <Alert color="red">{apiError(preview.error)}</Alert>;
  const p = preview.data;
  const emptied = request.mode === "move" ? p.songs.filter((s) => s.emptied).length : 0;
  const namesOk = Object.values(names).every((n) => n.trim().length > 0);
  const ready =
    namesOk &&
    songName.trim().length > 0 &&
    target !== null &&
    (target !== NEW_PROJECT || newName.trim());
  return (
    <Stack gap="sm" data-testid="multitrack-dialog">
      <Text size="sm">
        {request.mode === "copy"
          ? t("transfer.copyTracksExplain", { count: p.tracks.length })
          : t("transfer.multitrackExplain", { count: p.tracks.length })}
      </Text>
      <ScrollArea.Autosize mah={220}>
        <Table data-testid="multitrack-tracks" verticalSpacing={4}>
          <Table.Tbody>
            {p.tracks.map((tr, i) => (
              <Table.Tr key={tr.id}>
                <Table.Td>
                  <TextInput
                    size="sm"
                    aria-label={t("transfer.trackName", { index: i + 1 })}
                    value={names[tr.id] ?? tr.name}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setNames((prev) => ({ ...prev, [tr.id]: v }));
                    }}
                    error={(names[tr.id] ?? tr.name).trim() === ""}
                    maxLength={120}
                    styles={{ input: { minHeight: 44 } }}
                    data-testid="multitrack-track-name"
                  />
                  <Text size="xs" c="dimmed" mt={2}>
                    {tr.songTitle}
                  </Text>
                </Table.Td>
                <Table.Td ta="right" className="tabular-nums">
                  <Text size="sm">
                    {tr.durationSec === null ? "–" : formatDuration(tr.durationSec)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
      {p.lengthsDiffer && (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          data-testid="multitrack-length-warning"
        >
          {t("transfer.lengthsDiffer")}
        </Alert>
      )}
      {emptied > 0 && (
        <Alert
          color="gray"
          variant="light"
          icon={<IconTrash size={16} />}
          data-testid="multitrack-emptied"
        >
          {t("transfer.emptiedToTrash", { count: emptied })}
        </Alert>
      )}
      <TextInput
        label={t("transfer.songName")}
        value={songName}
        onChange={(e) => {
          setName(e.currentTarget.value);
        }}
        maxLength={200}
        data-testid="multitrack-name"
      />
      <TargetPicker value={target} onChange={setTarget} newName={newName} onNewName={setNewName} />
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
          data-testid="multitrack-submit"
        >
          {request.mode === "copy" ? t("transfer.copy") : t("transfer.make")}
        </Button>
      </Group>
    </Stack>
  );
}
