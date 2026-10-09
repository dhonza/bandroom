import { Alert, Group, List, Stack, Table, Text } from "@mantine/core";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../i18n/format";
import { formatClock } from "../player/format";
import {
  processingLabel,
  processingRange,
  sizeVerdict,
  timelineParts,
  type ReviewView,
} from "./review";

/**
 * The numbers of an Apply/Bounce review (SPEC §24.8): the edited tracks with old and new
 * duration, the size against the quota and the free disk, the warnings, the processing time as
 * a range and what the timeline follow-up changes.
 */
export function ReviewSummary({
  review,
  showTimeline = true,
}: {
  review: ReviewView;
  showTimeline?: boolean;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const verdict = sizeVerdict(review);
  const time = processingLabel(processingRange(review.estimateSec));
  const parts = showTimeline && review.timeline ? timelineParts(review.timeline) : [];
  return (
    <Stack gap="sm" data-testid="edit-review">
      {review.tracks.length > 0 && (
        <Table.ScrollContainer minWidth={0}>
          <Table verticalSpacing={4} horizontalSpacing="xs" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("edit.review.track")}</Table.Th>
                <Table.Th w="34%" ta="right">
                  {t("edit.review.duration")}
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {review.tracks.map((tr) => (
                <Table.Tr key={tr.key} data-testid="edit-review-track">
                  <Table.Td>
                    <Text size="sm" truncate>
                      {tr.name}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" style={{ whiteSpace: "nowrap" }}>
                      {tr.oldSec === null
                        ? formatClock(tr.newSec, false)
                        : t("edit.review.oldNew", {
                            old: formatClock(tr.oldSec, false),
                            new: formatClock(tr.newSec, false),
                          })}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Stack gap={2}>
        <Text size="sm" data-testid="edit-review-size">
          {review.quotaLeft === null
            ? t("edit.review.size", { size: fmt.bytes(review.bytes) })
            : t("edit.review.sizeQuota", {
                size: fmt.bytes(review.bytes),
                left: fmt.bytes(Math.max(0, review.quotaLeft)),
              })}
          {review.diskFree !== null &&
            ` · ${t("edit.review.disk", { free: fmt.bytes(review.diskFree) })}`}
        </Text>
        <Text size="sm" c="dimmed" data-testid="edit-review-time">
          {t(`edit.review.time.${time.unit}`, { lo: time.lo, hi: time.hi })}
        </Text>
      </Stack>
      {verdict !== "ok" && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} data-testid="edit-review-full">
          {t(`edit.review.${verdict}`)}
        </Alert>
      )}
      {review.warnings.length > 0 && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          title={t("edit.review.warningsTitle")}
          data-testid="edit-review-warnings"
        >
          <List size="sm" spacing={2}>
            {review.warnings.map((w) => (
              <List.Item key={w.code} data-testid="edit-review-warning" data-code={w.code}>
                {t(`edit.review.warnings.${w.code}`, {
                  count: Math.max(1, w.tracks.length),
                  tracks: w.tracks.join(", "),
                })}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      {showTimeline && (
        <Text size="sm" data-testid="edit-review-timeline">
          {parts.length === 0
            ? t("edit.review.timelineNone")
            : parts.map((p) => t(`edit.review.timeline.${p.key}`, { count: p.count })).join(", ")}
        </Text>
      )}
    </Stack>
  );
}

/** "The old audio goes to Trash; you can restore it there." (Apply, SPEC §24.8). */
export function TrashNote() {
  const { t } = useTranslation();
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <Text span c="dimmed" style={{ display: "inline-flex", paddingTop: 2 }}>
        <IconTrash size={16} />
      </Text>
      <Text size="sm" c="dimmed">
        {t("edit.review.trashNote")}
      </Text>
    </Group>
  );
}
