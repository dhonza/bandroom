import { ActionIcon, Alert, Box, Group, Loader, Text } from "@mantine/core";
import {
  IconArrowsHorizontal,
  IconChevronLeft,
  IconChevronRight,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageTurn } from "../markers/keymap";
import { clampZoom, pinchDistance } from "./zoom";

// pdf.js runs its parser in a module worker served from our origin (CSP worker-src 'self').
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** iOS Safari refuses canvases above ~16.7 M pixels; stay well below. */
const MAX_CANVAS_PIXELS = 12_000_000;

/**
 * PDF viewer (SPEC §10) on pdf.js only (never the browser's plugin, same on iOS): one page at a
 * time for the music stand, page navigation, fit width, zoom buttons and pinch-zoom, and page
 * turns from the keyboard or a pedal through `onRegisterPager`.
 */
export function PdfView({
  url,
  onRegisterPager,
}: {
  url: string;
  onRegisterPager: (pager: (turn: PageTurn) => void) => () => void;
}) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  /** 1 = fit width. */
  const [zoom, setZoom] = useState(1);
  const [gesture, setGesture] = useState(1);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pages = doc?.numPages ?? 0;

  // The viewer is keyed by version, so a new URL means a fresh component (state starts empty).
  useEffect(() => {
    const task = pdfjs.getDocument({ url, withCredentials: true, enableXfa: false });
    let cancelled = false;
    task.promise.then(
      (d) => {
        if (!cancelled) setDoc(d);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  // Track the available width for "fit width".
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => {
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!doc || width === 0 || !canvas.current) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    const target = canvas.current;
    setRendering(true);
    void doc.getPage(page).then((p) => {
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const cssScale = ((width - 2) / base.width) * zoom;
      const dpr = window.devicePixelRatio || 1;
      const cssW = base.width * cssScale;
      const cssH = base.height * cssScale;
      const pixelScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
      const viewport = p.getViewport({ scale: cssScale * pixelScale });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      target.style.width = `${String(Math.floor(cssW))}px`;
      target.style.height = `${String(Math.floor(cssH))}px`;
      task = p.render({ canvas: target, viewport });
      task.promise.then(
        () => {
          if (!cancelled) setRendering(false);
        },
        () => undefined, // cancelled by a newer render
      );
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, width]);

  const turn = useCallback(
    (dir: PageTurn) => {
      setPage((p) => Math.min(Math.max(1, p + (dir === "next" ? 1 : -1)), Math.max(1, pages)));
      scroller.current?.scrollTo({ top: 0 });
    },
    [pages],
  );
  useEffect(() => onRegisterPager(turn), [onRegisterPager, turn]);

  // Pinch-zoom: scale the canvas with CSS during the gesture, re-render when it ends.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const startDist = useRef(0);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2)
      startDist.current = pinchDistance([...pointers.current.values()]);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && startDist.current > 0) {
      const ratio = pinchDistance([...pointers.current.values()]) / startDist.current;
      setGesture(clampZoom(zoom * ratio) / zoom);
    }
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size < 2 && gesture !== 1) {
      setZoom((z) => clampZoom(z * gesture));
      setGesture(1);
      startDist.current = 0;
    }
  };

  if (error) {
    return (
      <Alert color="red" data-testid="pdf-error">
        {t("documents.pdfError")}
      </Alert>
    );
  }
  return (
    <Box style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <Group justify="space-between" wrap="nowrap" gap={4} py={4}>
        <Group gap={4} wrap="nowrap">
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={() => {
              turn("prev");
            }}
            disabled={page <= 1}
            aria-label={t("documents.prevPage")}
            data-testid="pdf-prev"
          >
            <IconChevronLeft size={22} />
          </ActionIcon>
          <Text size="sm" className="tabular-nums" data-testid="pdf-page" miw={56} ta="center">
            {pages > 0 ? t("documents.pageOf", { page, pages }) : "…"}
          </Text>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={() => {
              turn("next");
            }}
            disabled={page >= pages}
            aria-label={t("documents.nextPage")}
            data-testid="pdf-next"
          >
            <IconChevronRight size={22} />
          </ActionIcon>
        </Group>
        <Group gap={4} wrap="nowrap">
          {rendering && <Loader size="xs" />}
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={() => {
              setZoom((z) => clampZoom(z / 1.25));
            }}
            aria-label={t("documents.zoomOut")}
          >
            <IconZoomOut size={20} />
          </ActionIcon>
          <ActionIcon
            size={44}
            variant={zoom === 1 ? "light" : "subtle"}
            color="gray"
            onClick={() => {
              setZoom(1);
            }}
            aria-label={t("documents.fitWidth")}
            data-testid="pdf-fit"
          >
            <IconArrowsHorizontal size={20} />
          </ActionIcon>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={() => {
              setZoom((z) => clampZoom(z * 1.25));
            }}
            aria-label={t("documents.zoomIn")}
            data-testid="pdf-zoom-in"
          >
            <IconZoomIn size={20} />
          </ActionIcon>
        </Group>
      </Group>
      <Box
        ref={scroller}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        data-testid="pdf-scroller"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          touchAction: "pan-x pan-y",
          background: "var(--mantine-color-default-hover)",
          borderRadius: "var(--mantine-radius-sm)",
        }}
      >
        {!doc && (
          <Group justify="center" p="xl">
            <Loader />
          </Group>
        )}
        <canvas
          ref={canvas}
          data-testid="pdf-canvas"
          data-page={page}
          data-pages={pages}
          style={{
            display: doc ? "block" : "none",
            margin: "0 auto",
            background: "white",
            transform: gesture !== 1 ? `scale(${String(gesture)})` : undefined,
            transformOrigin: "top center",
          }}
        />
      </Box>
    </Box>
  );
}
