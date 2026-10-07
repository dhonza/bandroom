import {
  computeTotals,
  validateMapping,
  type ImportMapping,
  type ImportRun,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../../../api/useApiError";
import { formatBytes } from "../../../lib/media";
import { CancelRunButton } from "./CancelRunButton";
import { dryRunPlannedCounts } from "./mappingEdit";
import { ProjectTree } from "./ProjectTree";
import { useStartImport } from "./queries";

/** Review step (SPEC §17.1 step 4): proposed roles per Samply item, totals, dry run / start. */
export function MappingReview({ run }: { run: ImportRun }) {
  const { t, i18n } = useTranslation();
  const apiError = useApiError();
  const [mapping, setMapping] = useState<ImportMapping | null>(run.mapping);
  const totals = useMemo(() => (mapping ? computeTotals(mapping) : null), [mapping]);
  const problems = useMemo(() => (mapping ? validateMapping(mapping) : []), [mapping]);
  const start = useStartImport(run.id, mapping);
  if (!mapping || !totals) return null;
  const dryReport = run.report?.dryRun ? run.report : null;

  return (
    <Stack>
      <Title order={4}>{t("admin.import.review.title")}</Title>
      <Text size="sm" c="dimmed">
        {t("admin.import.review.explain")}
      </Text>
      {dryReport && (
        <Alert color="blue" variant="light" data-testid="dry-run-summary">
          {t("admin.import.review.lastDryRun", {
            summary: dryRunPlannedCounts(dryReport.counts)
              .map(([kind, n]) => `${t(`admin.import.kind.${kind}`)} ${n}`)
              .join(", "),
          })}
        </Alert>
      )}

      <Paper withBorder p="md" data-testid="import-totals">
        <Text fw={600} mb="xs">
          {t("admin.import.totals.title")}
        </Text>
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
          <Stat label={t("admin.import.totals.songs")} value={totals.songs} />
          <Stat label={t("admin.import.totals.tracks")} value={totals.tracks} />
          <Stat label={t("admin.import.totals.versions")} value={totals.versions} />
          <Stat label={t("admin.import.totals.documents")} value={totals.documents} />
          <Stat label={t("admin.import.totals.comments")} value={totals.comments} />
          <Stat
            label={t("admin.import.totals.size")}
            value={formatBytes(totals.bytes, i18n.language)}
          />
          {totals.alreadyImported > 0 && (
            <Stat label={t("admin.import.totals.alreadyImported")} value={totals.alreadyImported} />
          )}
        </SimpleGrid>
      </Paper>

      {mapping.projects.map((p) => (
        <ProjectTree
          key={p.samplyId}
          project={p}
          onChange={(fn) => {
            setMapping((m) => (m ? fn(m) : m));
          }}
        />
      ))}

      <Checkbox
        label={t("admin.import.review.insights")}
        checked={mapping.includeInsights}
        onChange={(e) => {
          const on = e.currentTarget.checked;
          setMapping((m) => (m ? { ...m, includeInsights: on } : m));
        }}
      />

      {problems.length > 0 && (
        <Alert color="red" title={t("admin.import.review.problems")} data-testid="import-problems">
          <List size="sm">
            {problems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {start.isError && <Alert color="red">{apiError(start.error)}</Alert>}
      <Group justify="space-between">
        <CancelRunButton runId={run.id} />
        <Group>
          <Button
            variant="default"
            disabled={problems.length > 0}
            loading={start.isPending && start.variables}
            onClick={() => {
              start.mutate(true);
            }}
            data-testid="import-dry-run"
          >
            {t("admin.import.review.dryRun")}
          </Button>
          <Button
            disabled={problems.length > 0 || totals.songs + totals.documents === 0}
            loading={start.isPending && !start.variables}
            onClick={() => {
              start.mutate(false);
            }}
            data-testid="import-start"
          >
            {t("admin.import.review.start")}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} className="tabular-nums">
        {value}
      </Text>
    </Stack>
  );
}
