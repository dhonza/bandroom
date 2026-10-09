import { listSongTracks, type UploadTarget } from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconDeviceFloppy, IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { AppModal } from "../components/ResponsivePanel";
import { songKeys } from "../features/library/queries";
import { uploadOptions } from "../upload/prefs";
import {
  clampNudge,
  formatOffset,
  formatTakeTime,
  NUDGE_STEPS,
  nextRecordingName,
  takeOffsetSamples,
} from "./model";
import { discardTake, saveTake, useTakes } from "./takes";
import { takeExtension, type TakeFormat, type TakeMeta } from "./takeTypes";

/** File names keep letters, digits and a few separators; the extension follows the format. */
function fileNameFor(name: string, format: TakeFormat): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Recording";
  return `${base.slice(0, 100)}.${takeExtension(format)}`;
}

/** "Recording 2026-10-09 19:30", localized. */
export function defaultSongTitle(base: string, at: number, locale: string): string {
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(at),
  );
  return `${base} ${when}`;
}

/** A nudge in ms with the ±1/10/100 ms buttons (SPEC §9); positive moves the take later. */
export function NudgeControl({
  value,
  onChange,
  label,
  min,
}: {
  value: number;
  onChange: (ms: number) => void;
  label: string;
  /** Lowest value (ms); default −2000. */
  min?: number;
}) {
  const { t } = useTranslation();
  const step = (d: number) => (
    <ActionIcon
      key={d}
      variant="default"
      size={44}
      onClick={() => {
        onChange(Math.max(min ?? -Infinity, value + d));
      }}
      aria-label={t("record.nudgeBy", { ms: d > 0 ? `+${String(d)}` : String(d) })}
      data-testid={`nudge-${d > 0 ? "plus" : "minus"}-${String(Math.abs(d))}`}
    >
      <Text size="xs" fw={600}>
        {d > 0 ? `+${String(d)}` : String(d)}
      </Text>
    </ActionIcon>
  );
  // The field above, the six buttons in one row (fits 360 px).
  return (
    <Stack gap={6}>
      <NumberInput
        label={label}
        value={value}
        onChange={(v) => {
          onChange(typeof v === "number" ? v : Number(v) || 0);
        }}
        size="md"
        decimalScale={2}
        suffix=" ms"
        hideControls
        data-testid="nudge-ms"
        {...(min !== undefined && { min })}
      />
      <Group gap={4} wrap="nowrap" justify="center">
        {[...NUDGE_STEPS].reverse().map((s) => step(-s))}
        {NUDGE_STEPS.map((s) => step(s))}
      </Group>
    </Stack>
  );
}

/**
 * The stop dialog (SPEC §9), also for recovered takes: where the take goes (a new track or a new
 * version on a song; a new song on the project page), its label and a nudge; Save queues the
 * upload, Discard (confirmed) deletes the take.
 */
export function TakeDialog({ meta }: { meta: TakeMeta }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const songMode = meta.mode === "song" && meta.songId !== null;
  const tracks = useQuery({
    queryKey: songKeys.tracks(meta.songId ?? ""),
    queryFn: ({ signal }) => api(listSongTracks, { params: { id: meta.songId ?? "" } }, { signal }),
    enabled: songMode,
  });
  const list = useMemo(() => tracks.data?.tracks ?? [], [tracks.data]);
  const base = t("record.trackBase");
  const [kind, setKind] = useState<"track" | "version">("track");
  const [name, setName] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [title, setTitle] = useState(() => defaultSongTitle(base, meta.createdAt, locale));
  const [label, setLabel] = useState("");
  const [nudge, setNudge] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackName =
    name ??
    nextRecordingName(
      base,
      list.map((tr) => tr.name),
    );
  const offset = takeOffsetSamples(meta, nudge);
  const pendingCount = useTakes((s) => s.review.length);

  const save = async () => {
    const opts = uploadOptions();
    const audio = {
      source: "recording" as const,
      offsetSamples: offset,
      ...(opts && { options: opts }),
    };
    let target: UploadTarget;
    let shown: string;
    if (!songMode) {
      const songTitle = title.trim() || defaultSongTitle(base, meta.createdAt, locale);
      const first = nextRecordingName(base, []);
      target = {
        type: "newSong",
        projectId: meta.projectId,
        title: songTitle,
        trackName: first,
        ...audio,
      };
      shown = songTitle;
    } else if (kind === "version" && trackId) {
      target = { type: "newVersion", trackId, ...audio };
      shown = list.find((tr) => tr.id === trackId)?.name ?? trackName;
    } else {
      shown =
        trackName.trim() ||
        nextRecordingName(
          base,
          list.map((tr) => tr.name),
        );
      target = { type: "newTrack", songId: meta.songId ?? "", name: shown, ...audio };
    }
    setBusy(true);
    setError(null);
    try {
      await saveTake(meta, {
        target,
        label,
        title: shown,
        filename: fileNameFor(shown, meta.format),
      });
    } catch {
      setError(t("record.errors.save"));
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    await discardTake(meta).catch(() => undefined);
  };

  const reason =
    meta.endedBy && meta.endedBy !== "user" ? t(`record.endedBy.${meta.endedBy}`) : null;

  return (
    <AppModal
      opened
      onClose={() => undefined}
      withCloseButton={false}
      closeOnEscape={false}
      closeOnClickOutside={false}
      centered
      title={meta.recovered ? t("record.recoverTitle") : t("record.saveTitle")}
      data-testid="take-dialog"
    >
      <Stack gap="md" data-testid="take-dialog-body" data-take={meta.takeId}>
        <Group gap="xs">
          <Text size="sm" data-testid="take-length">
            {t("record.length", { time: formatTakeTime(meta.frames) })}
          </Text>
          {meta.channels === 2 && <Badge variant="light">{t("record.stereo")}</Badge>}
          {meta.recovered && (
            <Badge color="yellow" variant="light">
              {t("record.recovered")}
            </Badge>
          )}
          {pendingCount > 1 && (
            <Badge variant="outline">{t("record.moreTakes", { count: pendingCount - 1 })}</Badge>
          )}
        </Group>
        {meta.recovered && <Text size="sm">{t("record.recoverExplain")}</Text>}
        {reason && (
          <Alert color="yellow" icon={<IconAlertTriangle size={18} />} data-testid="take-ended-by">
            {t("record.endedReason", { reason })}
          </Alert>
        )}

        {songMode ? (
          <>
            {list.length > 0 && (
              <SegmentedControl
                fullWidth
                value={kind}
                onChange={(v) => {
                  setKind(v === "version" ? "version" : "track");
                }}
                data={[
                  { value: "track", label: t("record.asNewTrack") },
                  { value: "version", label: t("record.asNewVersion") },
                ]}
                data-testid="take-kind"
              />
            )}
            {kind === "version" && list.length > 0 ? (
              <Select
                label={t("record.versionOf")}
                data={list.map((tr) => ({ value: tr.id, label: tr.name }))}
                value={trackId}
                onChange={setTrackId}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
                data-testid="take-track"
              />
            ) : (
              <TextInput
                label={t("record.trackName")}
                value={trackName}
                maxLength={120}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                }}
                data-testid="take-name"
              />
            )}
          </>
        ) : (
          <TextInput
            label={t("record.songTitle")}
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.currentTarget.value);
            }}
            data-testid="take-title"
          />
        )}
        <TextInput
          label={t("record.label")}
          placeholder={t("record.labelPlaceholder")}
          value={label}
          maxLength={120}
          onChange={(e) => {
            setLabel(e.currentTarget.value);
          }}
          data-testid="take-label"
        />
        <NudgeControl
          label={t("record.nudge")}
          value={nudge}
          onChange={(v) => {
            setNudge(clampNudge(v));
          }}
        />
        <Stack gap={0}>
          <Text size="sm" data-testid="take-offset" data-offset={offset}>
            {t("record.placedAt", { time: formatOffset(offset) })}
          </Text>
          <Text size="xs" c="dimmed">
            {t("record.nudgeHint")}
          </Text>
        </Stack>
        {error && <Alert color="red">{error}</Alert>}

        {confirmDiscard ? (
          <Stack gap="xs">
            <Text size="sm" c="red">
              {t("record.discardConfirm")}
            </Text>
            <Group justify="flex-end" gap="xs">
              <Button
                variant="default"
                h={44}
                onClick={() => {
                  setConfirmDiscard(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                color="red"
                h={44}
                loading={busy}
                onClick={() => {
                  void discard();
                }}
                data-testid="take-discard-confirm"
              >
                {t("record.discard")}
              </Button>
            </Group>
          </Stack>
        ) : (
          <Group justify="space-between" gap="xs">
            <Button
              variant="subtle"
              color="red"
              h={44}
              leftSection={<IconTrash size={16} />}
              onClick={() => {
                setConfirmDiscard(true);
              }}
              data-testid="take-discard"
            >
              {t("record.discard")}
            </Button>
            <Button
              h={44}
              leftSection={<IconDeviceFloppy size={16} />}
              loading={busy}
              disabled={kind === "version" && songMode && list.length > 0 && !trackId}
              onClick={() => {
                void save();
              }}
              data-testid="take-save"
            >
              {t("common.save")}
            </Button>
          </Group>
        )}
      </Stack>
    </AppModal>
  );
}

/** Shows the stop dialog for the first take waiting for it (fresh, or recovered after a crash). */
export function TakeReviewHost() {
  const first = useTakes((s) => s.review[0] ?? null);
  if (!first) return null;
  return <TakeDialog key={first.takeId} meta={first} />;
}
