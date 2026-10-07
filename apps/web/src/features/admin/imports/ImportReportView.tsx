import type { ImportReportItem, ImportRun } from "@bandroom/shared";
import { Alert, Button, Code, Group, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { InviteCreateModal } from "../InviteCreateModal";

const KINDS: ImportReportItem["kind"][] = [
  "project",
  "song",
  "track",
  "version",
  "document",
  "comment",
  "insight",
];
const OUTCOMES: ImportReportItem["outcome"][] = ["imported", "existing", "skipped", "failed"];

/** Report step (SPEC §17.1 step 6): imported / existing / failed, and authors to invite. */
export function ImportReportView({ run, onDone }: { run: ImportRun; onDone: () => void }) {
  const { t } = useTranslation();
  const [inviting, setInviting] = useState(false);
  const report = run.report;
  const rows = KINDS.filter((k) => OUTCOMES.some((o) => report?.counts[`${k}.${o}`]));
  const failures = report?.items.filter((i) => i.outcome === "failed") ?? [];
  return (
    <Stack data-testid="import-report">
      <Title order={4}>{t("admin.import.report.title")}</Title>
      {run.error && <Alert color="red">{run.error}</Alert>}
      {report && rows.length > 0 && (
        <Paper withBorder p="xs">
          <Table.ScrollContainer minWidth={320}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("admin.import.report.kind")}</Table.Th>
                  {OUTCOMES.map((o) => (
                    <Table.Th key={o} ta="right">
                      {t(`admin.import.report.${o}`)}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((k) => (
                  <Table.Tr key={k} data-testid={`report-row-${k}`}>
                    <Table.Td>{t(`admin.import.kind.${k}`)}</Table.Td>
                    {OUTCOMES.map((o) => (
                      <Table.Td key={o} ta="right" className="tabular-nums">
                        {report.counts[`${k}.${o}`] ?? 0}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
      {failures.length > 0 && (
        <Alert color="red" title={t("admin.import.report.failures")}>
          <Stack gap={4}>
            {failures.map((f, i) => (
              <Text key={i} size="sm">
                {f.name}: {f.reason}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {report && report.unmatchedAuthors.length > 0 && (
        <Paper withBorder p="md">
          <Stack gap="xs">
            <Text fw={600}>{t("admin.import.report.unmatched")}</Text>
            <Text size="sm" c="dimmed">
              {t("admin.import.report.unmatchedExplain")}
            </Text>
            {report.unmatchedAuthors.map((a) => (
              <Text key={a.name} size="sm">
                {a.name}
                {a.email ? ` · ${a.email}` : ""}
              </Text>
            ))}
            <Group>
              <Button
                variant="light"
                onClick={() => {
                  setInviting(true);
                }}
              >
                {t("admin.import.report.invite")}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {report && report.log.length > 0 && (
        <Code block style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>
          {report.log.join("\n")}
        </Code>
      )}
      <Group>
        <Button variant="default" onClick={onDone}>
          {t("admin.import.back")}
        </Button>
      </Group>
      <InviteCreateModal
        opened={inviting}
        onClose={() => {
          setInviting(false);
        }}
      />
    </Stack>
  );
}
