import type { TrackVersion } from "@bandroom/shared";
import { Badge, Group, Progress, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDuration } from "../../lib/media";
import { LossyBadge } from "../../lossless/LossyBadge";
import { OverviewWave } from "./OverviewWave";

/** A version's processing state, or its waveform and media facts when ready. */
export function VersionStatus({
  version: v,
  color,
  locale,
}: {
  version: TrackVersion;
  color: string;
  locale: string;
}) {
  const { t } = useTranslation();
  if (v.status === "failed") {
    return (
      <Text size="xs" c="red" data-testid="track-failed">
        {t("tracks.failed")}
        {v.error ? `: ${v.error}` : ""}
      </Text>
    );
  }
  if (v.status !== "ready") {
    return (
      <Stack gap={4} data-testid="track-processing">
        <Progress value={(v.progress ?? 0) * 100} size="sm" animated />
        <Text size="xs" c="dimmed">
          {t("tracks.processing", { percent: Math.round((v.progress ?? 0) * 100) })}
        </Text>
      </Stack>
    );
  }
  const m = v.media;
  return (
    <Stack gap={4}>
      {v.variants.peaks && <OverviewWave overview={v.variants.peaks.overview} color={color} />}
      {m && (
        <Group gap={6} wrap="wrap">
          <Text size="xs" c="dimmed" className="tabular-nums">
            {[
              formatDuration(m.durationSec),
              t("tracks.sampleRate", { khz: Math.round(m.sampleRate / 100) / 10 }),
              m.bitDepth ? t("tracks.bitDepth", { bits: m.bitDepth }) : null,
              formatBytes(v.sizeBytes, locale),
              m.integratedLufs !== null
                ? t("tracks.lufs", { lufs: m.integratedLufs.toFixed(1) })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          <LossyBadge version={v} />
          {m.dualMono && (
            <Badge size="xs" variant="outline" color="gray">
              {t("tracks.dualMono")}
            </Badge>
          )}
        </Group>
      )}
    </Stack>
  );
}
