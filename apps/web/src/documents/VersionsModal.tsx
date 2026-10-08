import type { Document, DocumentVersion } from "@bandroom/shared";
import { ActionIcon, Alert, Badge, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { IconDownload, IconEye, IconStar, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { useFormatters } from "../i18n/format";
import { formatBytes } from "../lib/media";
import {
  documentDownloadUrl,
  useDeleteDocumentVersion,
  useDocumentVersions,
  useSetCurrentDocumentVersion,
} from "./queries";
import { AppModal } from "../components/ResponsivePanel";

/** The version stack (SPEC §10: like tracks): view, make current (editor), download, delete. */
export function VersionsModal({
  doc,
  onClose,
  onViewVersion,
}: {
  doc: Document;
  onClose: () => void;
  onViewVersion?: (version: DocumentVersion) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const fmt = useFormatters();
  const apiError = useApiError();
  const versions = useDocumentVersions(doc.id);
  const removeVersion = useDeleteDocumentVersion();
  const makeCurrent = useSetCurrentDocumentVersion(doc.id);
  const list = versions.data?.versions ?? [];
  return (
    <AppModal
      opened
      onClose={onClose}
      title={t("documents.versionsTitle", { title: doc.title })}
      centered
      size="lg"
      data-testid="doc-versions-modal"
    >
      <Stack gap="sm">
        {makeCurrent.isError && <Alert color="red">{apiError(makeCurrent.error)}</Alert>}
        {versions.isPending && <Loader size="sm" />}
        {list.map((v) => {
          return (
            <Paper key={v.id} withBorder p="sm" radius="md" data-testid="doc-version-row">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text fw={600}>{t("documents.versionLabel", { number: v.number })}</Text>
                    {v.isCurrent && (
                      <Badge size="sm" variant="light">
                        {t("documents.current")}
                      </Badge>
                    )}
                    {v.source === "edit" && (
                      <Badge size="sm" variant="light" color="gray">
                        {t("documents.edited")}
                      </Badge>
                    )}
                    {v.source === "import" && (
                      <Badge size="sm" variant="light" color="gray">
                        {t("documents.imported")}
                      </Badge>
                    )}
                  </Group>
                  <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                    {[
                      v.uploaderName ?? t("comments.deletedUser"),
                      fmt.dateTime(v.createdAt),
                      formatBytes(v.sizeBytes, locale),
                    ].join(" · ")}
                  </Text>
                  {v.notes && (
                    <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                      {v.notes}
                    </Text>
                  )}
                </Stack>
                <Group gap={4} wrap="nowrap">
                  {onViewVersion && (
                    <ActionIcon
                      size={44}
                      variant="subtle"
                      color="gray"
                      aria-label={t("documents.viewVersion", { number: v.number })}
                      onClick={() => {
                        onViewVersion(v);
                        onClose();
                      }}
                      data-testid="doc-view-version"
                    >
                      <IconEye size={18} />
                    </ActionIcon>
                  )}
                  {!v.isCurrent && doc.canSetCurrent && (
                    <ActionIcon
                      size={44}
                      variant="subtle"
                      color="gray"
                      aria-label={t("documents.makeCurrent", { number: v.number })}
                      onClick={() => {
                        makeCurrent.mutate(v.id);
                      }}
                      data-testid="doc-make-current"
                    >
                      <IconStar size={18} />
                    </ActionIcon>
                  )}
                  {doc.canDownload && (
                    <ActionIcon
                      component="a"
                      href={documentDownloadUrl(v.id)}
                      download
                      size={44}
                      variant="subtle"
                      color="gray"
                      aria-label={t("documents.downloadVersion", { number: v.number })}
                    >
                      <IconDownload size={18} />
                    </ActionIcon>
                  )}
                  {list.length > 1 && v.canDelete && (
                    <ActionIcon
                      size={44}
                      variant="subtle"
                      color="red"
                      aria-label={t("documents.deleteVersion", { number: v.number })}
                      onClick={() => {
                        void removeVersion(v.id, v.number);
                      }}
                      data-testid="doc-delete-version"
                    >
                      <IconTrash size={18} />
                    </ActionIcon>
                  )}
                </Group>
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </AppModal>
  );
}
