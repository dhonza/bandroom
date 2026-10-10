import {
  createMixerSnapshot,
  deleteMixerSnapshot,
  MixerSnapshotNameSchema,
  updateTrack,
  type MixerSnapshot,
} from "@bandroom/shared";
import { ActionIcon, Box, Button, Group, Menu, Stack, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconDeviceFloppy,
  IconFileMusic,
  IconMicrophoneOff,
  IconRestore,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { AppModal } from "../components/ResponsivePanel";
import { songKeys } from "../features/library/queries";
import { isLinkMode } from "../links/linkMode";
import {
  applySnapshot,
  hasMyInstrument,
  muteMyInstrument,
  pageState,
  resetMix,
  setLoudnessMatch,
  usePlayerView,
} from "./controller";

/** The mixer tools' song data (SPEC §11.3, §31.1). */
export interface MixerToolsProps {
  songId: string;
  snapshots: MixerSnapshot[];
  /** Editors can make the current mix everyone's starting point (track defaults). */
  canSetDefaults: boolean;
  /** The song is locked: "Save as default mix" is shown disabled. */
  defaultsLocked?: boolean;
  /** Opens "Bounce to new song…" (SPEC §5.5); absent when the user may not bounce. */
  onBounce?: (() => void) | undefined;
}

/** "Save snapshot…" outlives the menu that opens it. */
const useSnapshotDialog = create<{ open: boolean }>(() => ({ open: false }));

function useMixerActions(songId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: songKeys.mixer(songId) });
  };
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  const del = useMutation({
    mutationFn: (snapshotId: string) =>
      api(deleteMixerSnapshot, { params: { id: songId, snapshotId } }),
    onSuccess: refresh,
    onError,
  });
  const saveDefaults = useMutation({
    mutationFn: () =>
      Promise.all(
        Object.entries(pageState().mix.tracks).map(([id, s]) =>
          api(updateTrack, {
            params: { id },
            body: {
              defaultGainDb: Math.max(-120, s.gainDb),
              defaultPan: s.pan,
              defaultMuted: s.mute,
            },
          }),
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: songKeys.tracks(songId) });
      notifications.show({ color: "teal", message: t("rehearse.defaultsSaved") });
    },
    onError,
  });
  const toggleLoudness = (on: boolean) => {
    const byTrack = Object.fromEntries(
      pageState().tracks.map((p) => [
        p.track.id,
        qc.getQueryData<{ versions: never[] }>(songKeys.versions(songId, p.track.id))?.versions ??
          [],
      ]),
    );
    setLoudnessMatch(on, byTrack);
  };
  return { del, saveDefaults, toggleLoudness };
}

/** "Mute my instrument" as an icon (SPEC §31.1); link visitors have no instrument. */
export function MuteMineButton({ size }: { size: number }) {
  const { t } = useTranslation();
  if (isLinkMode()) return null;
  const mine = hasMyInstrument();
  return (
    <Tooltip label={mine ? t("rehearse.muteMine") : t("rehearse.setInstrument")}>
      <ActionIcon
        size={size}
        variant="subtle"
        color="gray"
        // A disabled button would not show its tooltip.
        data-disabled={!mine || undefined}
        aria-disabled={!mine || undefined}
        aria-label={t("rehearse.muteMine")}
        onClick={() => {
          if (mine) muteMyInstrument();
        }}
        data-testid="mixer-mute-mine"
      >
        <IconMicrophoneOff size={Math.round(size * 0.55)} />
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * The Mixes menu (SPEC §11.3, §31.1): the snapshots (apply, delete), "Save snapshot…", "Save as
 * default mix" (editors) and the loudness-matched A/B. Items for a Menu dropdown.
 */
export function MixesMenuItems({
  songId,
  snapshots,
  canSetDefaults,
  defaultsLocked = false,
}: MixerToolsProps) {
  const { t } = useTranslation();
  const { del, saveDefaults, toggleLoudness } = useMixerActions(songId);
  const loudnessMatch = usePlayerView((s) => s.loudnessMatch);
  const anyAB = usePlayerView((s) => Object.keys(s.ab).length > 0);
  const personal = !isLinkMode();
  return (
    <>
      {personal && (
        <>
          <Menu.Label>{t("rehearse.snapshots")}</Menu.Label>
          {snapshots.length === 0 && <Menu.Label>{t("rehearse.noSnapshots")}</Menu.Label>}
          {snapshots.map((s) => (
            <Group key={s.id} gap={0} wrap="nowrap">
              <Menu.Item
                style={{ flex: 1 }}
                leftSection={<IconCamera size={14} />}
                closeMenuOnClick
                onClick={() => {
                  applySnapshot(s.state);
                }}
              >
                {s.name}
              </Menu.Item>
              <ActionIcon
                size={44}
                variant="subtle"
                color="red"
                aria-label={t("rehearse.deleteSnapshot", { name: s.name })}
                onClick={() => {
                  del.mutate(s.id);
                }}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Menu.Item
            leftSection={<IconDeviceFloppy size={14} />}
            closeMenuOnClick
            onClick={() => {
              useSnapshotDialog.setState({ open: true });
            }}
            data-testid="mixer-save-snapshot"
          >
            {t("rehearse.saveSnapshot")}
          </Menu.Item>
        </>
      )}
      {canSetDefaults && (
        <Menu.Item
          closeMenuOnClick
          disabled={defaultsLocked || saveDefaults.isPending}
          onClick={() => {
            saveDefaults.mutate();
          }}
          title={defaultsLocked ? t("songs.lock.locked") : t("rehearse.saveDefaultsHint")}
          data-testid="mixer-save-defaults"
        >
          {t("rehearse.saveDefaults")}
        </Menu.Item>
      )}
      {anyAB && (
        <Menu.Item
          leftSection={loudnessMatch ? <IconCheck size={14} /> : <Box w={14} />}
          onClick={() => {
            toggleLoudness(!loudnessMatch);
          }}
          role="menuitemcheckbox"
          aria-checked={loudnessMatch}
          data-testid="mixer-loudness-match"
        >
          {t("rehearse.loudnessMatch")}
        </Menu.Item>
      )}
    </>
  );
}

/**
 * The mixer tools of the desktop context row (SPEC §31.1), shown while the Mixer is open: reset,
 * mute my instrument, "Mixes ▾" and bounce, as icons with tooltips.
 */
export function MixerTools(props: MixerToolsProps & { size: number }) {
  const { t } = useTranslation();
  const { size, onBounce } = props;
  const icon = Math.round(size * 0.55);
  return (
    <Box
      role="group"
      aria-label={t("rehearse.mixerTools")}
      style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
      data-testid="mixer-tools"
    >
      <Tooltip label={t("rehearse.resetMix")}>
        <ActionIcon
          size={size}
          variant="subtle"
          color="gray"
          aria-label={t("rehearse.resetMix")}
          onClick={resetMix}
          data-testid="mixer-reset"
        >
          <IconRestore size={icon} />
        </ActionIcon>
      </Tooltip>
      <MuteMineButton size={size} />
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            h={size}
            px={6}
            size="compact-sm"
            variant="subtle"
            color="gray"
            leftSection={<IconCamera size={icon} />}
            rightSection={<IconChevronDown size={12} />}
            data-testid="mixer-mixes"
          >
            {t("rehearse.mixes")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown miw={220}>
          <MixesMenuItems {...props} />
        </Menu.Dropdown>
      </Menu>
      {onBounce && (
        <Tooltip label={t("bounce.action")}>
          <ActionIcon
            size={size}
            variant="subtle"
            color="gray"
            aria-label={t("bounce.action")}
            onClick={onBounce}
            data-testid="mixer-bounce"
          >
            <IconFileMusic size={icon} />
          </ActionIcon>
        </Tooltip>
      )}
    </Box>
  );
}

/** The mixer tools in the phone and landscape "⋯" (SPEC §31.1): reset and the Mixes items. */
export function MixerMenuItems(props: MixerToolsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Menu.Label>{t("rehearse.mixerTools")}</Menu.Label>
      <Menu.Item
        leftSection={<IconRestore size={14} />}
        closeMenuOnClick
        onClick={resetMix}
        data-testid="mixer-reset"
      >
        {t("rehearse.resetMix")}
      </Menu.Item>
      <MixesMenuItems {...props} />
    </>
  );
}

/** "Save snapshot…": a name, then the current mix is saved (SPEC §11.3). */
export function SaveSnapshotDialog({ songId }: { songId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const open = useSnapshotDialog((s) => s.open);
  const [name, setName] = useState("");
  const close = () => {
    useSnapshotDialog.setState({ open: false });
  };
  const save = useMutation({
    mutationFn: () =>
      api(createMixerSnapshot, {
        params: { id: songId },
        body: { name: name.trim(), state: pageState().mix },
      }),
    onSuccess: () => {
      setName("");
      close();
      void qc.invalidateQueries({ queryKey: songKeys.mixer(songId) });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });
  const nameOk = MixerSnapshotNameSchema.safeParse(name).success;
  return (
    <AppModal
      opened={open}
      onClose={close}
      title={t("rehearse.saveSnapshot")}
      centered
      size="sm"
      data-testid="snapshot-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (nameOk) save.mutate();
        }}
      >
        <Stack gap="xs">
          <TextInput
            label={t("rehearse.snapshotName")}
            placeholder={t("rehearse.snapshotPlaceholder")}
            value={name}
            maxLength={80}
            data-autofocus
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Button type="submit" disabled={!nameOk} loading={save.isPending}>
            {t("common.save")}
          </Button>
        </Stack>
      </form>
    </AppModal>
  );
}
