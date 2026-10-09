import type { Comment } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { formatClock } from "../player/format";
import { useInkOnColor } from "../theme/ink";
import { secToX, type View } from "../timeline/view";
import { authorColor, initials, laneComments } from "./model";
import { useCommentsUi } from "./store";

/** Comment lane height: 44 px on touch devices (SPEC §11.1 touch targets), compact with a mouse. */
export function commentLaneHeight(coarse: boolean): number {
  return coarse ? 44 : 20;
}

/** Prefix of comment ids in `data-timeline-item` (taps arrive via the timeline's onItemTap). */
export const COMMENT_ITEM_PREFIX = "comment:";

/**
 * The comment lane (SPEC §8, §11.3): pins for point comments and spans for ranges, in the
 * author's color. A tap seeks there, highlights the comment and opens the panel.
 */
export function CommentsLane({
  view,
  comments,
  top,
  height,
}: {
  view: View;
  comments: readonly Comment[];
  top: number;
  height: number;
}) {
  const { t } = useTranslation();
  const showResolved = useCommentsUi((s) => s.filters.showResolved);
  const highlighted = useCommentsUi((s) => s.highlighted);
  const size = Math.min(height - 4, 24);
  const ink = useInkOnColor();
  return (
    <>
      {laneComments(comments, showResolved).map((c) => {
        const start = c.startSec ?? 0;
        const x0 = secToX(view, start);
        const x1 = c.endSec !== null ? secToX(view, c.endSec) : x0;
        if (x1 < -size || x0 > view.widthPx + size) return null;
        const color = authorColor(c.author);
        const active = highlighted === c.id;
        const label = t("comments.pinLabel", {
          name: c.author.name || t("comments.deletedUser"),
          at: formatClock(start, false),
        });
        return (
          <Box
            key={c.id}
            role="button"
            tabIndex={0}
            aria-label={label}
            data-timeline-item={`${COMMENT_ITEM_PREFIX}${c.id}`}
            data-testid="comment-pin"
            data-comment-id={c.id}
            data-active={active || undefined}
            style={{
              position: "absolute",
              left: x0 - Math.max(size, 44) / 2,
              top,
              height,
              width: Math.max(44, x1 - x0 + Math.max(size, 44)),
              maxWidth: Math.max(44, view.widthPx - x0 + 44),
              pointerEvents: "auto",
              cursor: "pointer",
              touchAction: "pan-y",
            }}
          >
            {c.endSec !== null && (
              <Box
                style={{
                  position: "absolute",
                  left: Math.max(size, 44) / 2,
                  width: Math.max(2, x1 - x0),
                  bottom: 3,
                  height: 4,
                  borderRadius: 2,
                  background: `var(--mantine-color-${color}-filled)`,
                  opacity: active ? 1 : 0.7,
                  pointerEvents: "none",
                }}
              />
            )}
            <Box
              style={{
                position: "absolute",
                left: Math.max(size, 44) / 2 - size / 2,
                top: (height - size) / 2 - (c.endSec !== null ? 2 : 0),
                width: size,
                height: size,
                borderRadius: "50%",
                background: `var(--mantine-color-${color}-filled)`,
                outline: active ? "2px solid var(--mantine-color-white)" : undefined,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <Text size={size < 18 ? "9px" : "10px"} fw={700} c={ink(color)} lh={1}>
                {initials(c.author.name || "?")}
              </Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
}
