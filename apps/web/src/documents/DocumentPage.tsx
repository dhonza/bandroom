import { Alert, Box, Center, Loader } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useProject } from "../features/library/queries";
import { NotFoundPage } from "../pages/NotFoundPage";
import { DocumentPane } from "./DocumentPane";
import { useDocument } from "./queries";
import { errorMessage } from "../api/errorMessage";
import { BackLink } from "../components/BackLink";

/**
 * A document on its own page (project documents, "Open on its own page"): the viewer fills the
 * screen, e.g. a setlist or sheet music on a tablet on the music stand.
 */
export function DocumentPage() {
  const { t } = useTranslation();
  const { documentId = "" } = useParams();
  const navigate = useNavigate();
  const query = useDocument(documentId);
  const doc = query.data?.document;
  const project = useProject(doc?.projectId ?? "");

  if (query.isPending) {
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  }
  if (query.isError || !doc) {
    if (query.error instanceof ApiError && query.error.code === "NOT_FOUND")
      return <NotFoundPage />;
    return <Alert color="red">{errorMessage(t, query.error)}</Alert>;
  }
  const back = doc.songId ? `/songs/${doc.songId}` : `/projects/${doc.projectId}?tab=documents`;
  const backLabel = doc.songId ? doc.songTitle : project.data?.project.name;
  const canUpload =
    project.data?.project.access.capabilities.includes("upload") === true &&
    (doc.songId !== null || project.data.project.visibility === "full");
  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        // Fill the viewport below the header (and above the tab bar / mini-player).
        height:
          "calc(100dvh - var(--app-shell-header-offset, 56px) - var(--app-shell-footer-offset, 0px) - 2 * var(--mantine-spacing-md))",
        minHeight: 360,
      }}
      data-testid="document-page"
    >
      <BackLink to={back}>{backLabel ?? t("documents.back")}</BackLink>
      <DocumentPane
        doc={doc}
        canUpload={canUpload}
        showOpenPage={false}
        onDeleted={() => {
          void navigate(back, { replace: true });
        }}
      />
    </Box>
  );
}
