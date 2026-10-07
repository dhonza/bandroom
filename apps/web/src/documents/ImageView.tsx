import { ActionIcon, Box, Group } from "@mantine/core";
import { IconArrowsHorizontal, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { blobUrl } from "../lib/media";
import { clampZoom, pinchDistance } from "./zoom";

/** Zoomable image viewer (SPEC §10): buttons, pinch, Ctrl/⌘+wheel; scroll to pan. */
export function ImageView({ hash, alt }: { hash: string; alt: string }) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(1);
  const [gesture, setGesture] = useState(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const startDist = useRef(0);
  const shown = clampZoom(zoom * gesture);

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
      setGesture(pinchDistance([...pointers.current.values()]) / startDist.current);
    }
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size < 2 && gesture !== 1) {
      setZoom(shown);
      setGesture(1);
      startDist.current = 0;
    }
  };

  return (
    <Box style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <Group justify="flex-end" gap={4} py={4}>
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
          data-testid="image-zoom-in"
        >
          <IconZoomIn size={20} />
        </ActionIcon>
      </Group>
      <Box
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        }}
        style={{ flex: 1, minHeight: 0, overflow: "auto", touchAction: "pan-x pan-y" }}
      >
        <img
          src={blobUrl(hash)}
          alt={alt}
          draggable={false}
          data-testid="doc-image"
          style={{ width: `${String(shown * 100)}%`, maxWidth: "none", display: "block" }}
        />
      </Box>
    </Box>
  );
}
