import type { ImportRun } from "@bandroom/shared";
import { Code, Group, Paper, Progress, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../../i18n/format";
import { CancelRunButton } from "./CancelRunButton";

/**
 * Progress of a running scan or import with the latest server log lines. `compact` (the header's
 * processing popover, SPEC §25.3) shows the label and bar only.
 */
export function RunProgress({
  run,
  compact = false,
}: {
  run: Pick<ImportRun, "id" | "status" | "dryRun" | "progress"> & {
    report?: ImportRun["report"];
  };
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const label =
    run.status === "scanning"
      ? t("admin.import.progress.scanning")
      : run.dryRun
        ? t("admin.import.progress.dryRunning")
        : t("admin.import.progress.running");
  const log = compact ? [] : (run.report?.log.slice(-8) ?? []);
  return (
    <Paper withBorder p={compact ? "sm" : "md"} data-testid="import-progress">
      <Stack>
        <Group justify="space-between">
          <Text fw={600}>{label}</Text>
          <Text size="sm" c="dimmed" className="tabular-nums">
            {fmt.percent(run.progress)}
          </Text>
        </Group>
        <Progress value={run.progress * 100} animated />
        {log.length > 0 && (
          // Server diagnostics for admins, kept in English (DECISIONS 2026-10-04).
          <Stack gap={4}>
            <Text size="sm" c="dimmed" id={`import-log-${run.id}`}>
              {t("admin.import.progress.technicalLog")}
            </Text>
            <Code
              block
              lang="en"
              aria-labelledby={`import-log-${run.id}`}
              style={{ whiteSpace: "pre-wrap" }}
            >
              {log.join("\n")}
            </Code>
          </Stack>
        )}
        {!compact && (
          <Group justify="flex-end">
            <CancelRunButton runId={run.id} />
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
