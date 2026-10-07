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
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { setPanelOpen, useCommentsUi } from "../comments/store";
import { activePlayer, goNext, goPrev, playPause } from "../markers/store";
import { useListen } from "../player/listenStore";
import { DESKTOP_QUERY } from "../shell/mediaQueries";
import { DocumentList, DocumentToolbar } from "./DocumentList";
import { DocumentPane } from "./DocumentPane";
import { useDocument, useProjectDocuments, useSongDocuments } from "./queries";
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
  const docs = useSongDocuments(song.id);
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

const TRANSPORT = '[data-testid="rehearse-transport"]';

/** Height of the phone Rehearse transport (0 in Listen mode), so the sheet ends above it. */
function useTransportHeight(active: boolean): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!active) return;
    const measure = () => {
      setH(document.querySelector<HTMLElement>(TRANSPORT)?.offsetHeight ?? 0);
    };
    const ro = new ResizeObserver(measure);
    const el = document.querySelector<HTMLElement>(TRANSPORT);
    if (el) ro.observe(el);
    const timer = setTimeout(measure, 0);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return active ? h : 0;
}

/**
 * Documents next to the player (SPEC §10, §11.3): on desktop a resizable panel beside the page
 * (the page moves aside, so the timeline stays usable), on phones and tablets a sheet that ends
 * above the fixed transport. Comments and documents share the right side: opening one closes
 * the other. `?doc=<id>` (notification links) opens a document.
 */
export function DocsPanel({ song }: { song: Song }) {
  const { t } = useTranslation();
  const desktop = useMediaQuery(DESKTOP_QUERY, false, { getInitialValueInEffect: false });
  const open = useDocsUi((s) => s.open);
  const documentId = useDocsUi((s) => s.documentId);
  const width = useDocsUi((s) => s.width);
  const commentsOpen = useCommentsUi((s) => s.panelOpen);
  const transportH = useTransportHeight(open && !desktop);
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
  const canUpload = song.access.capabilities.includes("upload");
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
      {!desktop && transportH === 0 && <SheetTransport />}
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
        bottom: `calc(var(--app-shell-footer-offset, 0px) + ${String(transportH)}px)`,
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
 * Listen mode has no fixed transport bar: the sheet carries previous / play-pause / next, so
 * the transport stays within thumb reach while reading (SPEC §10, §11.1).
 */
function SheetTransport() {
  const { t } = useTranslation();
  const playing = useListen((s) => s.status === "playing");
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

/** Song documents first, then the project's own (setlist, band rules). */
function SongDocsList({ song, canUpload }: { song: Song; canUpload: boolean }) {
  const { t } = useTranslation();
  const songDocs = useSongDocuments(song.id);
  const projectDocs = useProjectDocuments(song.project.id);
  const own = projectDocs.data?.documents ?? [];
  const open = (d: { id: string }) => {
    showDocument(d.id);
  };
  return (
    <Stack gap="sm" style={{ overflow: "auto", minHeight: 0 }}>
      {canUpload && <DocumentToolbar scope={{ projectId: song.project.id, songId: song.id }} />}
      <DocumentList
        documents={songDocs.data?.documents ?? []}
        loading={songDocs.isPending}
        scope={{ projectId: song.project.id, songId: song.id }}
        canUpload={canUpload}
        onOpen={open}
      />
      {own.length > 0 && (
        <>
          <Text size="sm" fw={600} c="dimmed" mt="xs">
            {t("documents.projectDocuments", { project: song.project.name })}
          </Text>
          <DocumentList
            documents={own}
            scope={{ projectId: song.project.id, songId: null }}
            canUpload={false}
            onOpen={open}
          />
        </>
      )}
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
