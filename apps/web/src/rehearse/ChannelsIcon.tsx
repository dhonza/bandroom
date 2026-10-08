import { Box, Group, Text, Tooltip } from "@mantine/core";
import { IconChartCircles, IconCircle } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

/** "Mono", "Stereo" or "Mono (dual mono source)": what a Mixer track plays. */
export function channelsLabel(t: TFunction, channels: number, dualMono: boolean): string {
  if (channels !== 1) return t("rehearse.channels.stereo");
  return t(dualMono ? "rehearse.channels.dualMono" : "rehearse.channels.mono");
}

/**
 * A small dimmed mono (one circle) / stereo (two circles) mark in a Mixer track header. Extra
 * information only: not a control, so no touch target; the label is in its tooltip and aria-label.
 */
export function ChannelsIcon({
  channels,
  dualMono,
  size = 14,
  withText = false,
}: {
  channels: number;
  dualMono: boolean;
  size?: number;
  /** The icon followed by its label as text (settings popover / sheet). */
  withText?: boolean;
}) {
  const { t } = useTranslation();
  const label = channelsLabel(t, channels, dualMono);
  const Icon = channels === 1 ? IconCircle : IconChartCircles;
  if (withText) {
    return (
      <Group gap={4} wrap="nowrap" c="dimmed" data-testid="track-channels-text">
        <Icon size={size} aria-hidden />
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Group>
    );
  }
  return (
    <Tooltip label={label}>
      <Box
        component="span"
        role="img"
        aria-label={label}
        data-testid="track-channels"
        data-channels={channels === 1 ? "mono" : "stereo"}
        c="dimmed"
        style={{ display: "inline-flex", flex: "none", verticalAlign: "middle", lineHeight: 0 }}
      >
        <Icon size={size} aria-hidden />
      </Box>
    </Tooltip>
  );
}
