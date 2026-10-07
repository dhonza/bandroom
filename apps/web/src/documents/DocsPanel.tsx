import type { Song } from "@bandroom/shared";
import {
  ActionIcon,
  Box,
  Button,
  CloseButton,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconFileText,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerTrackNextFilled,
  IconPlayerTrackPrevFilled,
} from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { setPanelOpen, useCommentsUi } from "../comments/store";
import { activePlayer, goNext, goPrev, playPause } from "../markers/store";
import { usePlayerView } from "../rehearse/controller";
import { DESKTOP_QUERY } from "../shell/mediaQueries";
import { DocumentList, DocumentToolbar } from "./DocumentList";
import { DocumentPane } from "./DocumentPane";
import { useProject } from "../features/library/queries";
import { useDocument, useProjectDocuments } from "./queries";
import {
  closeDocsPanel,
  docsPanelFor,
  DOCS_PANEL_MIN,
  openDocsPanel,
  setDocsPanelWidth,
  showDocument,
  useDocsUi,
} from "./store";

/** Desktop: how much the page content moves aside while the panel is open (split view). */
export function useDocsInset(): number {
  const desktop = useMediaQuery(DESKTOP_QUERY, false, { getInitialValueInEffect: false });
  const open = useDocsUi((s) => s.open);
  const width = useDocsUi((s) => s.width);
  return desktop && open ? width : 0;
}

/** "Docs (N)" next to the comments button (SPEC §11.3 "[Mixer] [Comments] [Docs]"). */
export function DocsButton({ song }: { song: Song }) {
  const { t } = useTranslation();
  const docs = useProjectDocuments(song.project.id);
  const n = docs.data?.documents.length ?? 0;
  return (
    <Button
      variant="light"
      h={44}
      leftSection={<IconFileText size={18} />}
      onClick={() => {
        openDocsPanel(n === 1 ? (docs.data?.documents[0]?.id ?? null) : null);
      }}
      data-testid="open-docs"
      aria-label={t("documents.openPanel", { count: n })}
    >
      {t("documents.button", { count: n })}
    </Button>
  );
}

/**
 * Documents next to the player (SPEC §10, §11.3): on desktop a resizable panel beside the page
 * (the page moves aside, so the timeline stays usable), on phones and tablets a sheet with its
 * own play/pause (it covers the Player's transport). Comments and documents share the right side: opening one closes
 * the other. `?doc=<id>` (notification links) opens a document.
 */
export function DocsPanel({ song }: { song: Song }) {
  const desktop = useMediaQuery(DESKTOP_QUERY, false, { getInitialValueInEffect: false });
  const open = useDocsUi((s) => s.open);
  const documentId = useDocsUi((s) => s.documentId);
  const width = useDocsUi((s) => s.width);
  const commentsOpen = useCommentsUi((s) => s.panelOpen);
  const [params, setParams] = useSearchParams();
  const deepLink = params.get("doc");

  useEffect(() => {
    docsPanelFor(song.id);
    return () => {
      docsPanelFor(null);
    };
  }, [song.id]);
  useEffect(() => {
    if (!deepLink) return;
    openDocsPanel(deepLink);
    setParams(
      (p) => {
        p.delete("doc");
        return p;
      },
      { replace: true },
    );
  }, [deepLink, setParams]);
  useEffect(() => {
    if (commentsOpen) closeDocsPanel();
  }, [commentsOpen]);
  useEffect(() => {
    if (open) setPanelOpen(false);
  }, [open]);

  if (!open) return null;
  return <DocsPanelBody song={song} desktop={desktop} documentId={documentId} width={width} />;
}

function DocsPanelBody({
  song,
  desktop,
  documentId,
  width,
}: {
  song: Song;
  desktop: boolean;
  documentId: string | null;
  width: number;
}) {
  const { t } = useTranslation();
  // Documents belong to the project (SPEC §28.4): uploading needs it there, in the full view.
  const project = useProject(song.project.id).data?.project;
  const canUpload =
    project?.visibility === "full" && project.access.capabilities.includes("upload");
  const body = documentId ? (
    <OpenDocument id={documentId} canUpload={canUpload} />
  ) : (
    <SongDocsList song={song} canUpload={canUpload} />
  );

  const header = (
    <Group justify="space-between" wrap="nowrap" px="sm" pt="xs">
      <Title order={2} size="h4">
        {t("documents.panelTitle")}
      </Title>
      {!desktop && <SheetTransport />}
      <CloseButton
        size={44}
        onClick={closeDocsPanel}
        aria-label={t("common.close")}
        data-testid="docs-close"
      />
    </Group>
  );

  if (desktop) {
    return (
      <Box
        component="aside"
        data-testid="docs-panel"
        data-layout="side"
        style={{
          position: "fixed",
          top: "var(--app-shell-header-offset, 56px)",
          bottom: "var(--app-shell-footer-offset, 0px)",
          right: 0,
          width,
          zIndex: 150,
          display: "flex",
          flexDirection: "column",
          background: "var(--mantine-color-body)",
          borderLeft: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <ResizeHandle width={width} />
        {header}
        <Box
          px="sm"
          pb="sm"
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          {body}
        </Box>
      </Box>
    );
  }
  return (
    <Box
      component="aside"
      data-testid="docs-panel"
      data-layout="sheet"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: "calc(var(--app-shell-header-offset, 56px) + 8px)",
        bottom: "var(--app-shell-footer-offset, 0px)",
        zIndex: 150,
        display: "flex",
        flexDirection: "column",
        background: "var(--mantine-color-body)",
        borderTop: "1px solid var(--mantine-color-default-border)",
        borderRadius: "12px 12px 0 0",
        boxShadow: "var(--mantine-shadow-lg)",
      }}
    >
      {header}
      <Box
        px="sm"
        pb="xs"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {body}
      </Box>
    </Box>
  );
}

/**
 * The sheet covers the Player's transport: it carries previous / play-pause / next, so they stay
 * within thumb reach while reading (SPEC §10, §11.1).
 */
function SheetTransport() {
  const { t } = useTranslation();
  const playing = usePlayerView((s) => s.status === "playing" || s.status === "buffering");
  if (!activePlayer()) return null;
  return (
    <Group gap={4} wrap="nowrap" data-testid="docs-sheet-transport">
      <ActionIcon
        size={44}
        variant="subtle"
        color="gray"
        onClick={goPrev}
        aria-label={t("markers.prev")}
      >
        <IconPlayerTrackPrevFilled size={18} />
      </ActionIcon>
      <ActionIcon
        size={44}
        radius="xl"
        variant="filled"
        onClick={playPause}
        aria-label={playing ? t("listen.pause") : t("listen.play")}
        data-testid="docs-sheet-play"
      >
        {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </ActionIcon>
      <ActionIcon
        size={44}
        variant="subtle"
        color="gray"
        onClick={goNext}
        aria-label={t("markers.next")}
      >
        <IconPlayerTrackNextFilled size={18} />
      </ActionIcon>
    </Group>
  );
}

function OpenDocument({ id, canUpload }: { id: string; canUpload: boolean }) {
  const { t } = useTranslation();
  const doc = useDocument(id);
  if (doc.isPending) return <Loader size="sm" />;
  if (doc.isError) {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          {t("documents.gone")}
        </Text>
        <Group>
          <Button
            variant="default"
            onClick={() => {
              showDocument(null);
            }}
          >
            {t("documents.backToList")}
          </Button>
        </Group>
      </Stack>
    );
  }
  return (
    <DocumentPane
      doc={doc.data.document}
      canUpload={canUpload}
      showOpenPage
      onBack={() => {
        showDocument(null);
      }}
      onDeleted={() => {
        showDocument(null);
      }}
    />
  );
}

/** The project's documents (SPEC §10, §28.4). */
function SongDocsList({ song, canUpload }: { song: Song; canUpload: boolean }) {
  const docs = useProjectDocuments(song.project.id);
  const scope = { projectId: song.project.id };
  return (
    <Stack gap="sm" style={{ overflow: "auto", minHeight: 0 }}>
      {canUpload && <DocumentToolbar scope={scope} />}
      <DocumentList
        documents={docs.data?.documents ?? []}
        loading={docs.isPending}
        scope={scope}
        canUpload={canUpload}
        onOpen={(d) => {
          showDocument(d.id);
        }}
      />
    </Stack>
  );
}

/** Drag the panel's left edge to resize it (desktop, remembered per device). */
function ResizeHandle({ width }: { width: number }) {
  const { t } = useTranslation();
  const start = useRef<{ x: number; w: number } | null>(null);
  const max = () => Math.max(DOCS_PANEL_MIN, Math.round(window.innerWidth * 0.7));
  return (
    <ActionIcon
      component="div"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("documents.resize")}
      aria-valuenow={width}
      tabIndex={0}
      variant="transparent"
      data-testid="docs-resize"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setDocsPanelWidth(Math.min(max(), width + 32));
        if (e.key === "ArrowRight") setDocsPanelWidth(width - 32);
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        setDocsPanelWidth(Math.min(max(), start.current.w + (start.current.x - e.clientX)));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      style={{
        position: "absolute",
        left: -6,
        top: 0,
        bottom: 0,
        width: 12,
        height: "auto",
        minWidth: 12,
        cursor: "col-resize",
        touchAction: "none",
        zIndex: 1,
      }}
    />
  );
}
