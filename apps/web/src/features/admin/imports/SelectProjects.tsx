import type { ImportRun } from "@bandroom/shared";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../../../api/useApiError";
import { useFormatters } from "../../../i18n/format";
import { formatBytes } from "../../../lib/media";
import { CancelRunButton } from "./CancelRunButton";
import { useImportProjects, useScanImport } from "./queries";

/** Step 2: pick the Samply projects to scan. */
export function SelectProjects({ run }: { run: ImportRun }) {
  const { t, i18n } = useTranslation();
  const fmt = useFormatters();
  const apiError = useApiError();
  const projects = useImportProjects(run.id, run.hasKey);
  const [selected, setSelected] = useState<string[]>(run.selection);
  const scan = useScanImport(run.id, selected);
  const list = projects.data?.projects ?? [];
  const allOn = list.length > 0 && selected.length === list.length;
  return (
    <Paper withBorder p="md">
      <Stack>
        <Title order={4}>{t("admin.import.select.title")}</Title>
        <Text size="sm" c="dimmed">
          {t("admin.import.select.explain")}
        </Text>
        {projects.isPending && <Loader size="sm" />}
        {projects.isError && <Alert color="red">{apiError(projects.error)}</Alert>}
        {projects.data && list.length === 0 && (
          <Text c="dimmed">{t("admin.import.select.empty")}</Text>
        )}
        {list.length > 1 && (
          <Checkbox
            label={t("admin.import.select.selectAll")}
            checked={allOn}
            indeterminate={selected.length > 0 && !allOn}
            onChange={() => {
              setSelected(allOn ? [] : list.map((p) => p.samplyId));
            }}
          />
        )}
        <Stack gap="xs">
          {list.map((p) => (
            <Checkbox
              key={p.samplyId}
              data-testid="import-project"
              checked={selected.includes(p.samplyId)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setSelected((s) => (on ? [...s, p.samplyId] : s.filter((x) => x !== p.samplyId)));
              }}
              label={
                <Group gap="xs">
                  <Text size="sm" fw={500}>
                    {p.name}
                  </Text>
                  {p.existingProjectId && (
                    <Badge size="xs" variant="light" color="teal">
                      {t("admin.import.select.imported")}
                    </Badge>
                  )}
                </Group>
              }
              description={[
                p.sizeBytes !== null ? formatBytes(p.sizeBytes, i18n.language) : null,
                p.timeModified
                  ? t("admin.import.select.modified", { when: fmt.relative(p.timeModified) })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </Stack>
        {scan.isError && <Alert color="red">{apiError(scan.error)}</Alert>}
        <Group justify="space-between">
          <CancelRunButton runId={run.id} />
          <Button
            disabled={selected.length === 0}
            loading={scan.isPending}
            onClick={() => {
              scan.mutate();
            }}
            data-testid="import-scan"
          >
            {t("admin.import.select.scan", { count: selected.length })}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
