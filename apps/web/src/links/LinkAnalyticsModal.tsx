import type { PublicLink } from "@bandroom/shared";
import { Alert, Loader, Modal, Paper, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../i18n/format";
import { useLinkAnalytics } from "./queries";
import { errorMessage } from "../api/errorMessage";

const STATS = ["opens", "visitors", "plays", "downloads", "comments", "passwordFailures"] as const;

/** Link analytics (SPEC §14.3): totals, per-song counts and recent visitor activity. */
export function LinkAnalyticsModal({ link, onClose }: { link: PublicLink; onClose: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const q = useLinkAnalytics(link.id);
  const actionLabel = (action: string, mode: unknown) => {
    switch (action) {
      case "link.opened":
        return t("links.analytics.actions.opened");
      case "link.played":
        return mode === "rehearse"
          ? t("links.analytics.actions.playedRehearse")
          : t("links.analytics.actions.played");
      case "asset.downloaded":
        return t("links.analytics.actions.downloaded");
      case "comment.created":
        return t("links.analytics.actions.commented");
      case "link.password_failed":
        return t("links.analytics.actions.passwordFailed");
      case "link.visitor_named":
        return t("links.analytics.actions.named");
      default:
        return action;
    }
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={t("links.analytics.title", { label: link.label || t("links.untitled") })}
      centered
      size="xl"
    >
      {q.isPending && <Loader size="sm" />}
      {q.isError && <Alert color="red">{errorMessage(t, q.error)}</Alert>}
      {q.data && (
        <Stack gap="md" data-testid="link-analytics-modal">
          <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
            {STATS.map((k) => (
              <Paper key={k} withBorder p="xs" radius="md" data-testid={`link-stat-${k}`}>
                <Text size="xl" fw={700} className="tabular-nums">
                  {q.data.stats[k]}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(`links.analytics.stats.${k}`)}
                </Text>
              </Paper>
            ))}
          </SimpleGrid>
          <Text size="xs" c="dimmed">
            {t("links.analytics.playsHint")}
          </Text>
          {q.data.songs.length > 0 && (
            <Stack gap={4}>
              <Title order={4} size="h5">
                {t("links.analytics.perSong")}
              </Title>
              <Table.ScrollContainer minWidth={320}>
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("links.analytics.song")}</Table.Th>
                      <Table.Th>{t("links.analytics.stats.plays")}</Table.Th>
                      <Table.Th>{t("links.analytics.stats.downloads")}</Table.Th>
                      <Table.Th>{t("links.analytics.stats.comments")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {q.data.songs.map((s) => (
                      <Table.Tr key={s.songId}>
                        <Table.Td>{s.title}</Table.Td>
                        <Table.Td className="tabular-nums">{s.plays}</Table.Td>
                        <Table.Td className="tabular-nums">{s.downloads}</Table.Td>
                        <Table.Td className="tabular-nums">{s.comments}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Stack>
          )}
          <Stack gap={4}>
            <Title order={4} size="h5">
              {t("links.analytics.recent")}
            </Title>
            {q.data.recent.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t("links.analytics.noActivity")}
              </Text>
            ) : (
              <Stack gap={2} data-testid="link-activity">
                {q.data.recent.map((r) => (
                  <Text key={r.id} size="sm">
                    <Text span c="dimmed" size="xs" className="tabular-nums">
                      {fmt.dateTime(r.ts)}
                    </Text>{" "}
                    <Text span fw={600}>
                      {r.visitorName ?? t("links.analytics.visitor", { id: r.visitor ?? "?" })}
                    </Text>{" "}
                    {actionLabel(r.action, r.details.mode)}
                    {r.songTitle ? ` · ${r.songTitle}` : ""}
                  </Text>
                ))}
              </Stack>
            )}
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}
