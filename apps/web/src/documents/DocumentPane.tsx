import type { Document, DocumentVersion } from "@bandroom/shared";
import { ActionIcon, Badge, Box, Button, Group, Text, Title } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DocumentMenu } from "./DocumentActions";
import { DocumentViewer } from "./DocumentViewer";

/**
 * A document with its header (title, version, actions) and the viewer below, filling the
 * available height. Used by the split view panel and the document page.
 */
export function DocumentPane({
  doc,
  canUpload,
  onBack,
  showOpenPage,
  onDeleted,
}: {
  doc: Document;
  canUpload: boolean;
  onBack?: () => void;
  showOpenPage: boolean;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  // An older version picked in the version list; forgotten when the current version changes
  // (e.g. a new upload), so the pane goes back to the current one.
  const currentId = doc.current?.id ?? null;
  const [picked, setPicked] = useState<{ base: string | null; v: DocumentVersion } | null>(null);
  const viewing = picked && picked.base === currentId ? picked.v : null;
  const setViewing = (v: DocumentVersion | null) => {
    setPicked(v ? { base: currentId, v } : null);
  };
  const version = viewing ?? doc.current;
  return (
    <Box
      style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
      data-testid="doc-pane"
    >
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
          {onBack && (
            <ActionIcon
              size={44}
              variant="subtle"
              color="gray"
              onClick={onBack}
              aria-label={t("documents.backToList")}
              data-testid="doc-back"
            >
              <IconArrowLeft size={20} />
            </ActionIcon>
          )}
          <Title order={3} size="h5" lineClamp={2} data-testid="doc-pane-title">
            {doc.title}
          </Title>
          {version && doc.versionCount > 1 && (
            <Badge variant="light" color={version.isCurrent ? "blue" : "orange"} flex="none">
              {t("documents.versionLabel", { number: version.number })}
            </Badge>
          )}
        </Group>
        <DocumentMenu
          doc={doc}
          canUpload={canUpload}
          onViewVersion={setViewing}
          showOpenPage={showOpenPage}
          onDeleted={onDeleted}
        />
      </Group>
      {viewing && !viewing.isCurrent && (
        <Group gap="xs" py={4}>
          <Text size="sm" c="orange">
            {t("documents.viewingOld", { number: viewing.number })}
          </Text>
          <Button
            size="compact-sm"
            variant="subtle"
            onClick={() => {
              setViewing(null);
            }}
          >
            {t("documents.showCurrent")}
          </Button>
        </Group>
      )}
      {version ? (
        <DocumentViewer key={version.id} document={doc} version={version} />
      ) : (
        <Text size="sm" c="dimmed">
          {t("documents.noVersion")}
        </Text>
      )}
    </Box>
  );
}
