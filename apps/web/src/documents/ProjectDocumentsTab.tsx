import type { Project } from "@bandroom/shared";
import { Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { DocumentList, DocumentToolbar } from "./DocumentList";
import { useProjectDocuments } from "./queries";

/**
 * Project page "Documents" tab (SPEC §11.2, §28.4): the project's documents (setlist, lyrics,
 * chords, band rules). Users who see the project only through song grants have none.
 */
export function ProjectDocumentsTab({ project }: { project: Project }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const docs = useProjectDocuments(project.id);
  const caps = project.access.capabilities;
  const full = project.visibility === "full";
  const canUpload = full && caps.includes("upload");
  const scope = { projectId: project.id };
  const open = (d: { id: string }) => {
    void navigate(`/documents/${d.id}`);
  };
  return (
    <Stack gap="lg" data-testid="project-documents">
      {full ? (
        <Stack gap="sm">
          {canUpload && <DocumentToolbar scope={scope} />}
          <DocumentList
            documents={docs.data?.documents ?? []}
            loading={docs.isPending}
            scope={scope}
            canUpload={canUpload}
            onOpen={open}
            emptyText={t("documents.emptyProject")}
          />
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          {t("documents.empty")}
        </Text>
      )}
    </Stack>
  );
}
