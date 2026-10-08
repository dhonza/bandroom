import { canActOn, listTrackVersions, type Song } from "@bandroom/shared";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Slider,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import {
  IconAdjustmentsHorizontal,
  IconArrowsExchange,
  IconChevronDown,
  IconStack2,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useOptionalUser } from "../auth/session";
import { songKeys } from "../features/library/queries";
import { VersionStackModal } from "../features/song/VersionStackModal";
import { listenToVersion, setTrack, startAB, toggleAB, usePlayerView } from "./controller";
import { ChannelsIcon } from "./ChannelsIcon";
import { headerButtonSize, headerTier } from "./headerTier";
import { Meter } from "./Meter";
import type { PlayableTrack } from "./model";
import { paintProps } from "./paintToggle";
import { TrackColorBar, TrackColorPalette } from "./TrackColor";
import { PitchLockedBadge, TrackPracticeSettings } from "./TrackTranspose";
import { PanelPopover } from "../components/ResponsivePanel";
import { trackTint } from "../timeline/render";
import { VersionGainBadge, VersionGainField } from "./VersionGain";

const FADER_MIN = -60;

export function formatDb(db: number, t: TFunction): string {
  if (db <= FADER_MIN) return t("rehearse.dbSilent");
  const v = Math.round(db * 10) / 10;
  return t("rehearse.db", { value: v > 0 ? `+${v}` : String(v) });
}

export function formatPan(pan: number, t: TFunction): string {
  const v = Math.round(Math.abs(pan) * 100);
  if (v === 0) return t("rehearse.panCenter");
  return pan < 0 ? t("rehearse.panLeft", { value: v }) : t("rehearse.panRight", { value: v });
}

/**
 * One track's header left of its timeline lane (SPEC §11.3; DECISIONS 2026-10-07): name, version
 * (`v3 ▾`), M/S, fader with dB readout, pan and version gain, a post-fader peak meter (a bar on
 * full headers, a thin vertical one along the edge of shorter ones) and a thin buffering line. It adapts
 * to the lane height (`headerTier`): on short lanes and on narrow (`compact`, phone) headers the
 * fader and the rest move into the settings popover, so M/S are never clipped.
 */
export function TrackStrip({
  playable,
  song,
  height,
  compact = false,
}: {
  playable: PlayableTrack;
  song: Song;
  /** The lane height. */
  height: number;
  /** A narrow header (phones): name above M/S; a tap on the name opens the settings. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { track, version } = playable;
  const state = usePlayerView((s) => s.mix.tracks[track.id]);
  const anySolo = usePlayerView((s) => Object.values(s.mix.tracks).some((x) => x.solo));
  const buffered = usePlayerView((s) => s.buffer[track.id] ?? 0);
  const pair = usePlayerView((s) => s.ab[track.id]);
  const error = usePlayerView((s) => s.errors[track.id]);
  const [versionsOpen, versionsModal] = useDisclosure(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const userId = useOptionalUser()?.id ?? null;
  const canEditTrack =
    userId !== null && canActOn(song.access.role, "edit", track.createdBy === userId);
  const versions = useQuery({
    queryKey: songKeys.versions(song.id, track.id),
    queryFn: ({ signal }) => api(listTrackVersions, { params: { id: track.id } }, { signal }),
    enabled: pair !== undefined,
  });
  if (!state) return null;
  const all = versions.data?.versions ?? [];
  const audible = !state.mute && (!anySolo || state.solo);
  const otherId = pair ? (pair.a === version.id ? pair.b : pair.a) : null;
  const other = all.find((v) => v.id === otherId);
  const tier = headerTier(height, compact);
  const btn = headerButtonSize(height, compact);
  const inlineFader = !compact && tier !== "one";
  // What plays: a dual-mono source plays mono.
  const channels = playable.chosen.variant.channels;
  const dualMono = version.media?.dualMono ?? false;

  const versionButton = (
    <UnstyledButton
      onClick={versionsModal.open}
      aria-label={t("rehearse.versionMenu", { track: track.name, number: version.number })}
      data-testid="track-version"
      mih={44}
      style={{ flex: "none", display: "flex", alignItems: "center" }}
    >
      <Badge variant="light" color="gray" rightSection={<IconChevronDown size={12} />}>
        {t("rehearse.versionButton", { number: version.number })}
      </Badge>
    </UnstyledButton>
  );
  const notCurrent = track.current && track.current.id !== version.id && (
    <Badge variant="outline" color="yellow" size="sm" style={{ flex: "none" }}>
      {t("rehearse.notCurrent")}
    </Badge>
  );
  const abButton = pair && other && (
    <Tooltip label={t("rehearse.abToggle", { track: track.name, number: other.number })}>
      <Button
        size="compact-sm"
        variant="light"
        leftSection={<IconArrowsExchange size={14} />}
        onClick={() => {
          toggleAB(track.id, all);
        }}
        aria-label={t("rehearse.abToggle", { track: track.name, number: other.number })}
        data-testid="ab-toggle"
      >
        {version.id === pair.a ? "A" : "B"}
      </Button>
    </Tooltip>
  );

  const fullName = (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <Text size="sm" fw={600} truncate c={audible ? undefined : "dimmed"} title={track.name}>
        {track.name}
      </Text>
      {versionButton}
      <ChannelsIcon channels={channels} dualMono={dualMono} />
      <VersionGainBadge version={version} />
      {notCurrent}
      {abButton}
      <PitchLockedBadge track={track} />
    </Group>
  );

  // Short lanes: one small line; the version and A/B live in the settings popover.
  const smallName = (
    <Text
      size="xs"
      fw={600}
      lh="16px"
      truncate
      c={error ? "red" : audible ? undefined : "dimmed"}
      title={error ? t("rehearse.trackError", { track: track.name }) : track.name}
      style={{ minWidth: 0 }}
    >
      {track.name}
      <Text span size="xs" c="dimmed" fw={400}>
        {" "}
        {t("rehearse.versionButton", { number: version.number })}{" "}
        <ChannelsIcon channels={channels} dualMono={dualMono} size={12} />
      </Text>
    </Text>
  );

  const buttons = (
    <>
      <ActionIcon
        size={btn}
        variant={state.mute ? "filled" : "default"}
        color={state.mute ? "red" : "gray"}
        aria-pressed={state.mute}
        aria-label={t("rehearse.muteTrack", { track: track.name })}
        {...paintProps("mute", track.id, state.mute)}
        data-testid="track-mute"
      >
        <Text fw={700} size={btn < 32 ? "xs" : "sm"}>
          {t("rehearse.mute")}
        </Text>
      </ActionIcon>
      <ActionIcon
        size={btn}
        variant={state.solo ? "filled" : "default"}
        color={state.solo ? "yellow" : "gray"}
        aria-pressed={state.solo}
        aria-label={t("rehearse.soloTrack", { track: track.name })}
        {...paintProps("solo", track.id, state.solo)}
        data-testid="track-solo"
      >
        <Text fw={700} size={btn < 32 ? "xs" : "sm"} c={state.solo ? "dark" : undefined}>
          {t("rehearse.solo")}
        </Text>
      </ActionIcon>
    </>
  );

  const fader = (
    <Slider
      style={{ flex: 1, minWidth: 80 }}
      min={FADER_MIN}
      max={6}
      step={0.5}
      value={Math.max(FADER_MIN, state.gainDb)}
      onChange={(v) => {
        setTrack(track.id, { gainDb: v <= FADER_MIN ? -120 : v });
      }}
      label={(v) => formatDb(v, t)}
      thumbSize={20}
      color={track.color}
      thumbProps={{ "aria-label": t("rehearse.volume", { track: track.name }) }}
      data-testid="track-fader"
    />
  );

  const pan = (
    <Group gap="xs" wrap="nowrap">
      <Text size="xs" c="dimmed" w={32}>
        {formatPan(state.pan, t)}
      </Text>
      <Slider
        style={{ flex: 1 }}
        min={-1}
        max={1}
        step={0.05}
        value={state.pan}
        onChange={(v) => {
          setTrack(track.id, { pan: Math.abs(v) < 0.025 ? 0 : v });
        }}
        label={(v) => formatPan(v, t)}
        thumbSize={20}
        thumbProps={{ "aria-label": t("rehearse.pan", { track: track.name }) }}
      />
    </Group>
  );

  const bufferLine = (
    <Box
      h={2}
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        width: `${Math.min(100, (buffered / 4) * 100)}%`,
        background:
          buffered >= 1 ? "var(--mantine-color-default-border)" : "var(--mantine-color-blue-5)",
        transition: "width 250ms",
      }}
    />
  );

  const settingsLabel = t("rehearse.more", { track: track.name });
  const toggleSettings = () => {
    setSettingsOpen((o) => !o);
  };
  // Narrow headers: the whole header (behind M/S) is the settings button, with the name on top.
  const target = compact ? (
    <UnstyledButton
      onClick={toggleSettings}
      aria-label={settingsLabel}
      aria-haspopup="dialog"
      aria-expanded={settingsOpen}
      data-testid="track-settings"
      pos="absolute"
      inset={0}
      px={4}
      py={tier === "one" ? 0 : 2}
      style={{ display: "flex", alignItems: tier === "one" ? "center" : "flex-start" }}
    >
      <Box
        style={{ minWidth: 0, maxWidth: tier === "one" ? `calc(100% - ${2 * btn + 6}px)` : "100%" }}
      >
        {smallName}
      </Box>
    </UnstyledButton>
  ) : (
    <ActionIcon
      size={btn}
      variant="subtle"
      color="gray"
      onClick={toggleSettings}
      aria-label={settingsLabel}
      aria-haspopup="dialog"
      aria-expanded={settingsOpen}
      data-testid="track-settings"
    >
      <IconAdjustmentsHorizontal size={Math.min(18, btn - 8)} />
    </ActionIcon>
  );

  const panel = (
    <Stack gap="sm" data-testid="track-settings-panel">
      {tier !== "full" && (
        <>
          {/* The phone sheet has the name as its title. */}
          {!compact && (
            <Text size="sm" fw={600} truncate>
              {track.name}
            </Text>
          )}
          <Group gap="xs" wrap="wrap">
            <Button
              variant="light"
              h={44}
              leftSection={<IconStack2 size={16} />}
              rightSection={<IconChevronDown size={12} />}
              onClick={() => {
                setSettingsOpen(false);
                versionsModal.open();
              }}
              aria-label={t("rehearse.versionMenu", {
                track: track.name,
                number: version.number,
              })}
              data-testid="track-version"
            >
              {t("rehearse.versionButton", { number: version.number })}
            </Button>
            <ChannelsIcon channels={channels} dualMono={dualMono} withText />
            <VersionGainBadge version={version} />
            {notCurrent}
            {abButton}
            <PitchLockedBadge track={track} />
          </Group>
          {error && (
            <Text size="xs" c="red">
              {t("rehearse.trackError", { track: track.name })}
            </Text>
          )}
        </>
      )}
      {!inlineFader && (
        <div>
          <Text size="xs" fw={600} mb={4}>
            {t("rehearse.volume", { track: track.name })}
          </Text>
          {fader}
        </div>
      )}
      <div>
        <Text size="xs" fw={600} mb={4}>
          {t("rehearse.panLabel")}
        </Text>
        {pan}
      </div>
      <VersionGainField song={song} track={track} version={version} canEdit={canEditTrack} />
      <TrackPracticeSettings song={song} track={track} canEdit={canEditTrack} />
      {compact && canEditTrack && <TrackColorPalette track={track} />}
    </Stack>
  );

  // Phones and short screens: a full-screen panel (a popover below the header would run under
  // the transport); wider headers: a popover beside the header.
  const settings = (
    <PanelPopover
      opened={settingsOpen}
      onChange={setSettingsOpen}
      position="right"
      withArrow
      width={260}
      title={track.name}
      target={target}
    >
      {panel}
    </PanelPopover>
  );

  const modal = versionsOpen && (
    <VersionStackModal
      track={track}
      song={song}
      opened
      onClose={versionsModal.close}
      rehearse={{
        playingId: version.id,
        onListen: (v, list) => {
          listenToVersion(track.id, v, list);
        },
        onAB: (v, list) => {
          startAB(track.id, v, list);
        },
      }}
    />
  );

  const meterLabel = t("rehearse.meter", { track: track.name });
  let content;
  if (tier === "full") {
    content = (
      <Stack gap={2} px={6} py={2} justify="center" style={{ flex: 1, minWidth: 0 }}>
        {fullName}
        <Group gap={4} wrap="nowrap">
          {buttons}
          {fader}
          {settings}
        </Group>
        <Meter trackId={track.id} label={meterLabel} />
        {error && (
          <Text size="xs" c="red" truncate>
            {t("rehearse.trackError", { track: track.name })}
          </Text>
        )}
      </Stack>
    );
  } else if (compact) {
    content = (
      <Box pos="relative" style={{ flex: 1, minWidth: 0 }}>
        {settings}
        <Group
          gap={2}
          wrap="nowrap"
          pos="absolute"
          style={
            tier === "one"
              ? { right: 2, top: "50%", transform: "translateY(-50%)" }
              : { left: 2, bottom: 2 }
          }
        >
          {buttons}
        </Group>
      </Box>
    );
  } else if (tier === "two") {
    content = (
      <Stack gap={2} px={6} justify="center" style={{ flex: 1, minWidth: 0 }}>
        {smallName}
        <Group gap={4} wrap="nowrap">
          {buttons}
          {fader}
          {settings}
        </Group>
      </Stack>
    );
  } else {
    content = (
      <Group gap={4} px={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Box style={{ flex: 1, minWidth: 0 }}>{smallName}</Box>
        {buttons}
        {settings}
      </Group>
    );
  }

  return (
    <Group
      gap={0}
      h="100%"
      wrap="nowrap"
      align="stretch"
      data-testid="track-strip"
      data-track={track.name}
      data-tier={tier}
      style={{
        position: "relative",
        borderBottom: "1px solid var(--mantine-color-default-border)",
        // Tinted with the track colour at low alpha, like its lane (SPEC §25.10).
        background: trackTint(track.color),
      }}
    >
      {/* Narrow headers pick the colour in the settings popover (the bar is too thin to tap). */}
      <TrackColorBar track={track} canEdit={canEditTrack && !compact} />
      {content}
      {/* Shorter headers: a thin vertical meter along the edge, beside the buttons. */}
      {tier !== "full" && <Meter trackId={track.id} label={meterLabel} vertical />}
      {bufferLine}
      {modal}
    </Group>
  );
}
