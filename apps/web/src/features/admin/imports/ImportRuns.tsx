import {
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconPlugConnected } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../../i18n/format";
import { formatBytes } from "../../../lib/media";
import { ConnectCard } from "./ConnectCard";
import { runTitle } from "./mappingEdit";
import { useImportRuns } from "./queries";
import { STATUS_COLORS } from "./runStatus";

/** The list of import runs with "New import". */
export function ImportRuns({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const fmt = useFormatters();
  const runs = useImportRuns();
  const [connecting, setConnecting] = useState(false);
  return (
    <Stack>
      <Title order={3}>{t("admin.import.title")}</Title>
      <Text size="sm" c="dimmed">
        {t("admin.import.explain")}
      </Text>
      {connecting ? (
        <ConnectCard
          onConnected={onOpen}
          onCancel={() => {
            setConnecting(false);
          }}
        />
      ) : (
        <Group>
          <Button
            leftSection={<IconPlugConnected size={16} />}
            onClick={() => {
              setConnecting(true);
            }}
            data-testid="import-new"
          >
            {t("admin.import.newImport")}
          </Button>
        </Group>
      )}
      <Title order={4}>{t("admin.import.runs")}</Title>
      {runs.isPending && <Loader size="sm" />}
      {runs.data?.runs.length === 0 && <Text c="dimmed">{t("admin.import.noRuns")}</Text>}
      <Stack gap="xs">
        {runs.data?.runs.map((r) => (
          <UnstyledButton
            key={r.id}
            onClick={() => {
              onOpen(r.id);
            }}
            data-testid="import-run-row"
          >
            <Paper withBorder p="sm" mih={44}>
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {runTitle(r) || t("admin.import.title")}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {fmt.dateTime(r.createdAt)}
                    {r.totals ? ` · ${formatBytes(r.totals.bytes, i18n.language)}` : ""}
                  </Text>
                </Stack>
                <Badge color={STATUS_COLORS[r.status]} variant="light">
                  {t(`admin.import.status.${r.status}`)}
                </Badge>
              </Group>
            </Paper>
          </UnstyledButton>
        ))}
      </Stack>
    </Stack>
  );
}
