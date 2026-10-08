import {
  AUDIO_QUALITIES,
  AUDIO_QUALITY_KBPS,
  AudioQualitySchema,
  DEFAULT_AUDIO_QUALITY,
  type UploadOptions,
} from "@bandroom/shared";
import { Button, Select, Stack, Switch, Text } from "@mantine/core";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { PanelPopover, useSheetMode } from "../components/ResponsivePanel";
import { useUploadPrefs } from "./prefs";

/** "Keep full quality" or "Lossy on upload · 128 kbps stereo / 80 kbps mono". */
export function useUploadSummary(): (o: UploadOptions) => string {
  const { t } = useTranslation();
  return (o) => {
    const rates = AUDIO_QUALITY_KBPS[o.quality];
    if (o.lossyOnly) return t("upload.settings.summaryLossy", rates);
    return o.quality === DEFAULT_AUDIO_QUALITY
      ? t("upload.settings.keepFull")
      : t("upload.settings.summaryFull", rates);
  };
}

/**
 * The upload settings next to a dropzone (SPEC §28.2): a compact button with the current choice
 * that opens "Lossy on upload" and the Opus preset. Remembered on this device; every control
 * shows the same choice.
 */
export function UploadSettings({ testId = "upload-settings" }: { testId?: string }) {
  const { t } = useTranslation();
  const options = useUploadPrefs((s) => s.options);
  const set = useUploadPrefs((s) => s.set);
  const summary = useUploadSummary();
  const sheet = useSheetMode();
  return (
    <PanelPopover
      width={300}
      position="bottom-end"
      title={t("upload.settings.title")}
      testId={`${testId}-dropdown`}
      target={
        <Button
          variant="subtle"
          color={options.lossyOnly ? "yellow" : "gray"}
          size="compact-sm"
          // Both rates make the summary long: it wraps on a phone instead of being cut off.
          styles={{
            root: { height: "auto", minHeight: 44, maxWidth: "100%" },
            label: { whiteSpace: "normal", textAlign: "start" },
          }}
          leftSection={<IconAdjustmentsHorizontal size={16} aria-hidden />}
          aria-label={`${t("upload.settings.title")}: ${summary(options)}`}
          data-testid={testId}
          data-lossy={options.lossyOnly}
        >
          {summary(options)}
        </Button>
      }
    >
      <Stack gap="sm">
        {/* The full-screen panel has it as its title. */}
        {!sheet && (
          <Text fw={600} size="sm">
            {t("upload.settings.title")}
          </Text>
        )}
        <Switch
          label={t("upload.settings.lossyOnly")}
          description={t("upload.settings.lossyOnlyHint")}
          checked={options.lossyOnly}
          onChange={(e) => {
            set({ ...options, lossyOnly: e.currentTarget.checked });
          }}
          styles={{ body: { minHeight: 44, alignItems: "center" } }}
          data-testid="upload-lossy-only"
        />
        <Select
          label={t("upload.settings.quality")}
          description={t("upload.settings.qualityHint")}
          data={AUDIO_QUALITIES.map((q) => ({
            value: q,
            label: t(`upload.settings.qualities.${q}`, AUDIO_QUALITY_KBPS[q]),
          }))}
          value={options.quality}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
          onChange={(v) => {
            const q = AudioQualitySchema.safeParse(v);
            if (q.success) set({ ...options, quality: q.data });
          }}
          data-testid="upload-quality"
        />
      </Stack>
    </PanelPopover>
  );
}
