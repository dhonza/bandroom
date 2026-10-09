import {
  AUDIO_QUALITIES,
  AUDIO_QUALITY_KBPS,
  AudioQualitySchema,
  batchRemoveLossless,
  batchRemoveLosslessPreview,
  type AudioQuality,
  type BatchItems,
  type RemoveLosslessPreview,
} from "@bandroom/shared";
import { Alert, Button, Group, List, Loader, Select, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCopy } from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { opusRate } from "../lib/audioFormat";
import { formatBytes } from "../lib/media";
import { useInvalidateBatch } from "../trash/queries";
import { AppModal } from "../components/ResponsivePanel";

/**
 * "Remove full quality" (SPEC §26.4): shows what the server's preview says would happen (files,
 * space, skipped versions, lossy sources, shared copies) and needs a typed confirmation, since it
 * cannot be undone. `items` null keeps the dialog closed.
 */
export function RemoveLosslessDialog({
  items,
  onClose,
  onDone,
}: {
  items: BatchItems | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppModal opened={items !== null} onClose={onClose} title={t("lossless.title")} centered>
      {items && <DialogBody items={items} onClose={onClose} onDone={onDone} />}
    </AppModal>
  );
}

function DialogBody({
  items,
  onClose,
  onDone,
}: {
  items: BatchItems;
  onClose: () => void;
  onDone: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateBatch();
  const [typed, setTyped] = useState("");
  // The Opus that stays (SPEC §28.3): the current one, or a preset re-encoded first.
  const [quality, setQuality] = useState<AudioQuality | null>(null);
  const body = quality ? { ...items, quality } : items;
  const size = (n: number) => formatBytes(n, i18n.language);
  const preview = useQuery({
    queryKey: ["lossless", "preview", items, quality],
    queryFn: ({ signal }) => api(batchRemoveLosslessPreview, { body }, { signal }),
    gcTime: 0,
    staleTime: 0,
    // The dialog keeps its content while the preview for another quality loads.
    placeholderData: keepPreviousData,
  });
  const apply = useMutation({
    mutationFn: () => api(batchRemoveLossless, { body }),
    onSuccess: (r) => {
      invalidate();
      notifications.show({
        color: "teal",
        message: [
          r.count > 0 || r.reencoding === 0
            ? t("lossless.done", { count: r.count, size: size(r.usageBytes) })
            : null,
          r.reencoding > 0 ? t("lossless.doneQueued", { count: r.reencoding }) : null,
        ]
          .filter(Boolean)
          .join(" "),
      });
      onDone?.();
      onClose();
    },
  });
  const word = t("lossless.confirmWord");

  if (preview.isPending) {
    return (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  }
  if (preview.isError) {
    return (
      <Stack>
        <Alert color="red" data-testid="lossless-error">
          {apiError(preview.error)}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" h={44} onClick={onClose}>
            {t("common.close")}
          </Button>
        </Group>
      </Stack>
    );
  }
  const p = preview.data;
  const nothing = p.versions === 0;
  return (
    <Stack data-testid="lossless-dialog">
      <Text size="sm">{t("lossless.explain")}</Text>
      {nothing ? (
        <Alert color="gray" data-testid="lossless-nothing">
          {t("lossless.nothing")}
        </Alert>
      ) : (
        <>
          <Text size="sm" data-testid="lossless-now">
            {nowLine(t, p)}
          </Text>
          <Select
            label={t("lossless.quality")}
            description={t("lossless.qualityHint")}
            data={[
              {
                value: "keep",
                label: t("lossless.keepExisting", { opus: opusName(t, p.currentOpus) }),
              },
              ...AUDIO_QUALITIES.map((q) => ({
                value: q,
                label: t(`upload.settings.qualities.${q}`, AUDIO_QUALITY_KBPS[q]),
              })),
            ]}
            value={quality ?? "keep"}
            allowDeselect={false}
            // Inside the dialog: portalled into the page, the dropdown of the full-screen phone
            // dialog widened the layout viewport, moved, and so kept jumping (Pixel e2e).
            comboboxProps={{ withinPortal: false }}
            onChange={(v) => {
              const q = AudioQualitySchema.safeParse(v);
              setQuality(q.success ? q.data : null);
            }}
            data-testid="lossless-quality"
          />
          <Summary preview={p} size={size} />
          {p.reencode > 0 && (
            <Text size="sm" data-testid="lossless-reencode">
              {t("lossless.reencode", { count: p.reencode })}
            </Text>
          )}
        </>
      )}
      <Skipped preview={p} />
      {p.lossySources.count > 0 && (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={18} />}
          title={t("lossless.lossyTitle", { count: p.lossySources.count })}
          data-testid="lossless-lossy-warning"
        >
          <Text size="sm">{t("lossless.lossyExplain")}</Text>
          <List size="sm" mt={4}>
            {p.lossySources.items.map((v) => (
              <List.Item key={v.id}>
                {t("lossless.versionName", {
                  track: v.trackName,
                  number: v.number,
                  song: v.songTitle,
                })}
              </List.Item>
            ))}
          </List>
          {p.lossySources.count > p.lossySources.items.length && (
            <Text size="sm" c="dimmed">
              {t("lossless.andMore", { count: p.lossySources.count - p.lossySources.items.length })}
            </Text>
          )}
        </Alert>
      )}
      {p.sharedCopies > 0 && (
        <Alert color="orange" icon={<IconCopy size={18} />} data-testid="lossless-copies-warning">
          {t("lossless.copies", { count: p.sharedCopies })}
        </Alert>
      )}
      {apply.isError && <Alert color="red">{apiError(apply.error)}</Alert>}
      {!nothing && (
        <TextInput
          label={t("common.typeToConfirm", { name: word })}
          value={typed}
          data-testid="lossless-confirm-input"
          onChange={(e) => {
            setTyped(e.currentTarget.value);
          }}
        />
      )}
      <Group justify="flex-end">
        <Button variant="default" h={44} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {!nothing && (
          <Button
            color="red"
            h={44}
            disabled={
              typed.trim().toLowerCase() !== word.toLowerCase() || preview.isPlaceholderData
            }
            loading={apply.isPending}
            onClick={() => {
              apply.mutate();
            }}
            data-testid="lossless-confirm"
          >
            {t("lossless.action")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

type CurrentOpus = RemoveLosslessPreview["currentOpus"];

/** "96 kbps stereo / 64 kbps mono": the rates of the entries, stereo first. */
function ratesOf(t: TFunction, opus: CurrentOpus): string {
  const rate = (o: CurrentOpus[number]) => opusRate(t, o.kbps, o.channels);
  return [...new Set([...opus].sort((a, b) => b.channels - a.channels).map(rate))].join(" / ");
}

/** The presets of a mixed selection in table order, then the bitrates no preset uses. */
function mixedList(t: TFunction, opus: CurrentOpus): string {
  const known = new Set(opus.map((o) => o.quality));
  return [
    ...new Set([
      ...AUDIO_QUALITIES.filter((q) => known.has(q)).map((q) => t(`upload.settings.presets.${q}`)),
      ...opus
        .filter((o) => o.quality === null)
        .map((o) => t("lossless.now.raw", { rates: ratesOf(t, [o]) })),
    ]),
  ].join(", ");
}

/**
 * What the current Opus is called in the "keep" option: the one preset ("Standard"), "mixed:
 * Standard, High", or the raw rates when no preset uses them (`audio.opusBitrates` changed).
 */
function opusName(t: TFunction, opus: CurrentOpus): string {
  const known = new Set(opus.map((o) => o.quality));
  if (known.size === 0) return "?";
  if (known.size > 1) return t("lossless.now.mixed", { list: mixedList(t, opus) });
  const q = opus[0]?.quality;
  return q ? t(`upload.settings.presets.${q}`) : ratesOf(t, opus);
}

/** "Now: full quality (FLAC) · compressed copy Opus Standard (96 kbps stereo / 64 kbps mono)". */
function nowLine(t: TFunction, p: RemoveLosslessPreview): string {
  const kinds = [
    p.files.flac > 0 && "FLAC",
    p.files.wavpack > 0 && "WavPack",
    p.files.original > 0 && t("lossless.now.originals"),
  ].filter((x): x is string => typeof x === "string");
  const full =
    kinds.length > 0
      ? t("lossless.now.fullKinds", { kinds: kinds.join(", ") })
      : t("lossless.now.full");
  const opus = p.currentOpus;
  const known = new Set(opus.map((o) => o.quality));
  const q = opus[0]?.quality;
  const copy =
    known.size === 0
      ? null
      : known.size > 1
        ? t("lossless.now.opusMixed", { list: mixedList(t, opus) })
        : q
          ? t("lossless.now.opusPreset", {
              name: t(`upload.settings.presets.${q}`),
              rates: ratesOf(t, opus),
            })
          : t("lossless.now.opusRaw", { rates: ratesOf(t, opus) });
  return t("lossless.now.line", { parts: [full, copy].filter(Boolean).join(" · ") });
}

function Summary({
  preview: p,
  size,
}: {
  preview: RemoveLosslessPreview;
  size: (n: number) => string;
}) {
  const { t } = useTranslation();
  const files = [
    p.files.flac > 0 && t("lossless.files.flac", { count: p.files.flac }),
    p.files.original > 0 && t("lossless.files.original", { count: p.files.original }),
    p.files.wavmeta > 0 && t("lossless.files.wavmeta", { count: p.files.wavmeta }),
    p.files.wavpack > 0 && t("lossless.files.wavpack", { count: p.files.wavpack }),
  ].filter((x): x is string => typeof x === "string");
  return (
    <Stack gap={4} data-testid="lossless-summary">
      <Text fw={600}>{t("lossless.versions", { count: p.versions })}</Text>
      <Text size="sm">{files.join(" · ")}</Text>
      <Text size="sm" data-testid="lossless-space">
        {t("lossless.space", { usage: size(p.usageBytes) })}
      </Text>
      {p.bytesFreed < p.usageBytes && (
        <Text size="sm" c="dimmed">
          {p.bytesFreed === 0
            ? t("lossless.diskNone")
            : t("lossless.diskShared", { disk: size(p.bytesFreed) })}
        </Text>
      )}
    </Stack>
  );
}

function Skipped({ preview: p }: { preview: RemoveLosslessPreview }) {
  const { t } = useTranslation();
  const parts = [
    p.skipped.alreadyLossy > 0 &&
      t("lossless.skipped.alreadyLossy", { count: p.skipped.alreadyLossy }),
    p.skipped.notReady > 0 && t("lossless.skipped.notReady", { count: p.skipped.notReady }),
  ].filter((x): x is string => typeof x === "string");
  if (parts.length === 0) return null;
  return (
    <Text size="sm" c="dimmed" data-testid="lossless-skipped">
      {parts.join(" ")}
    </Text>
  );
}
