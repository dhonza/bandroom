import type { Processing } from "@bandroom/shared";
import { Badge, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../i18n/format";

/**
 * A song's media work (SPEC §25.3): failed (red) wins over processing (blue, with percent),
 * then waiting (gray), then the automatic mix being prepared. Nothing when all is done.
 */
export function ProcessingBadge({ processing }: { processing: Processing | undefined }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  if (!processing) return null;
  const { queued, failed, mix, progress } = processing;
  const running = processing.processing;
  let color: string;
  let label: string;
  let state: string;
  if (failed > 0) {
    color = "red";
    state = "failed";
    label = t("processing.badge.failed", { count: failed });
  } else if (running > 0) {
    color = "blue";
    state = "processing";
    label =
      progress !== null && progress > 0
        ? t("processing.badge.processingPercent", { percent: fmt.percent(progress) })
        : t("processing.badge.processing");
  } else if (queued > 0) {
    color = "gray";
    state = "queued";
    label = t("processing.badge.queued", { count: queued });
  } else if (mix !== null) {
    color = mix === "processing" ? "blue" : "gray";
    state = "mix";
    label = t("processing.badge.mix");
  } else {
    return null;
  }
  const parts = [
    failed > 0 && t("processing.tooltip.failed", { count: failed }),
    running > 0 && t("processing.tooltip.processing", { count: running }),
    queued > 0 && t("processing.tooltip.queued", { count: queued }),
    mix !== null && t(`processing.tooltip.mix_${mix}`),
  ].filter((p): p is string => typeof p === "string");
  return (
    <Tooltip label={parts.join(" · ")} multiline maw={260}>
      <Badge
        color={color}
        variant="light"
        size="sm"
        data-testid="processing-badge"
        data-state={state}
        style={{ flex: "none", textTransform: "none" }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
