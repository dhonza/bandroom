import {
  createMixerSnapshot,
  deleteMixerSnapshot,
  MixerSnapshotNameSchema,
  updateTrack,
  type MixerSnapshot,
} from "@bandroom/shared";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Popover,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCamera,
  IconFileMusic,
  IconMicrophoneOff,
  IconRestore,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { songKeys } from "../features/library/queries";
import {
  applySnapshot,
  hasMyInstrument,
  muteMyInstrument,
  resetMix,
  setLoudnessMatch,
  useRehearse,
} from "./controller";
import { isLinkMode } from "../links/linkMode";

/** Mixer actions (SPEC §11.3): reset, mute my instrument, snapshots, loudness-matched A/B. */
export function MixerTools({
  songId,
  snapshots,
  canSetDefaults,
  defaultsLocked = false,
  onBounce,
}: {
  songId: string;
  snapshots: MixerSnapshot[];
  /** Editors can make the current mix everyone's starting point (track defaults). */
  canSetDefaults: boolean;
  /** The song is locked: "Save as default mix" is shown disabled. */
  defaultsLocked?: boolean;
  /** Opens "Bounce to new song…" (SPEC §5.5); absent when the user may not bounce. */
  onBounce?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const loudnessMatch = useRehearse((s) => s.loudnessMatch);
  const anyAB = useRehearse((s) => Object.keys(s.ab).length > 0);
  const [name, setName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: songKeys.mixer(songId) });
  };
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  const save = useMutation({
    mutationFn: () =>
      api(createMixerSnapshot, {
        params: { id: songId },
        body: { name: name.trim(), state: useRehearse.getState().mix },
      }),
    onSuccess: () => {
      setName("");
      setSaveOpen(false);
      refresh();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (snapshotId: string) =>
      api(deleteMixerSnapshot, { params: { id: songId, snapshotId } }),
    onSuccess: refresh,
    onError,
  });
  const saveDefaults = useMutation({
    mutationFn: () =>
      Promise.all(
        Object.entries(useRehearse.getState().mix.tracks).map(([id, s]) =>
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
  const mine = hasMyInstrument();
  // Link visitors: no account, so no snapshots and no "my instrument".
  const personal = !isLinkMode();
  const nameOk = MixerSnapshotNameSchema.safeParse(name).success;

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        <Button
          variant="default"
          leftSection={<IconRestore size={16} />}
          onClick={resetMix}
          data-testid="mixer-reset"
        >
          {t("rehearse.resetMix")}
        </Button>
        {personal && (
          <Tooltip label={t("rehearse.setInstrument")} disabled={mine}>
            <Button
              variant="default"
              leftSection={<IconMicrophoneOff size={16} />}
              onClick={muteMyInstrument}
              disabled={!mine}
              data-testid="mixer-mute-mine"
            >
              {t("rehearse.muteMine")}
            </Button>
          </Tooltip>
        )}
        {personal && (
          <>
            <Menu position="bottom-start" withinPortal>
              <Menu.Target>
                <Button variant="default" leftSection={<IconCamera size={16} />}>
                  {t("rehearse.snapshots")}
                </Button>
              </Menu.Target>
              <Menu.Dropdown miw={220}>
                {snapshots.length === 0 && <Menu.Label>{t("rehearse.noSnapshots")}</Menu.Label>}
                {snapshots.map((s) => (
                  <Group key={s.id} gap={0} wrap="nowrap">
                    <Menu.Item
                      style={{ flex: 1 }}
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
              </Menu.Dropdown>
            </Menu>
            <Popover opened={saveOpen} onChange={setSaveOpen} withinPortal trapFocus>
              <Popover.Target>
                <Button
                  variant="subtle"
                  onClick={() => {
                    setSaveOpen((o) => !o);
                  }}
                >
                  {t("rehearse.saveSnapshot")}
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (nameOk) save.mutate();
                  }}
                >
                  <Stack gap="xs" w={240}>
                    <TextInput
                      label={t("rehearse.snapshotName")}
                      placeholder={t("rehearse.snapshotPlaceholder")}
                      value={name}
                      maxLength={80}
                      onChange={(e) => {
                        setName(e.currentTarget.value);
                      }}
                    />
                    <Button type="submit" disabled={!nameOk} loading={save.isPending}>
                      {t("common.save")}
                    </Button>
                  </Stack>
                </form>
              </Popover.Dropdown>
            </Popover>
          </>
        )}
        {canSetDefaults && (
          <Tooltip
            label={defaultsLocked ? t("songs.lock.locked") : t("rehearse.saveDefaultsHint")}
            multiline
            w={260}
          >
            <Button
              variant="subtle"
              // The default mix is frozen while the song is locked (SPEC §25.12); a disabled
              // button would not show its tooltip.
              data-disabled={defaultsLocked || undefined}
              aria-disabled={defaultsLocked || undefined}
              loading={saveDefaults.isPending}
              onClick={() => {
                if (!defaultsLocked) saveDefaults.mutate();
              }}
              data-testid="mixer-save-defaults"
            >
              {t("rehearse.saveDefaults")}
            </Button>
          </Tooltip>
        )}
        {onBounce && (
          <Button
            variant="subtle"
            leftSection={<IconFileMusic size={16} />}
            onClick={onBounce}
            data-testid="mixer-bounce"
          >
            {t("bounce.action")}
          </Button>
        )}
      </Group>
      {anyAB && (
        <Switch
          checked={loudnessMatch}
          onChange={(e) => {
            const byTrack = Object.fromEntries(
              useRehearse
                .getState()
                .tracks.map((p) => [
                  p.track.id,
                  qc.getQueryData<{ versions: never[] }>(songKeys.versions(songId, p.track.id))
                    ?.versions ?? [],
                ]),
            );
            setLoudnessMatch(e.currentTarget.checked, byTrack);
          }}
          label={<Text size="sm">{t("rehearse.loudnessMatch")}</Text>}
        />
      )}
    </Stack>
  );
}
