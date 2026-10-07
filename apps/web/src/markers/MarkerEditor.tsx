import {
  SECTION_PRESET_COLORS,
  SECTION_PRESETS,
  type Marker,
  type PaletteColor,
  type Song,
} from "@bandroom/shared";
import {
  Button,
  Chip,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ColorSwatchPicker } from "../components/ColorSwatchPicker";
import { formatClock } from "../player/format";
import { useTempoUi } from "../tempo/store";
import { numberedName, presetColor, presetForName, validateMarkerForm, type Range } from "./model";
import { useMarkerActions, useMarkerPermissions } from "./queries";
import { anchorNow, clearSelection, closeEditor, setSelection, useTimelineUi } from "./store";

/** Create or edit a marker/section: name (with section presets), color, note, times, delete. */
export function MarkerEditor({ song }: { song: Song }) {
  const editor = useTimelineUi((s) => s.editor);
  const markers = useTimelineUi((s) => s.markers);
  if (!editor) return null;
  const existing = editor.mode === "edit" ? markers.find((m) => m.id === editor.id) : undefined;
  if (editor.mode === "edit" && !existing) return null;
  const key = editor.mode === "edit" ? editor.id : `new-${editor.range.start}`;
  return <EditorModal key={key} song={song} editor={editor} existing={existing ?? null} />;
}

function EditorModal({
  song,
  editor,
  existing,
}: {
  song: Song;
  editor: NonNullable<ReturnType<typeof useTimelineUi.getState>["editor"]>;
  existing: Marker | null;
}) {
  const { t } = useTranslation();
  const markers = useTimelineUi((s) => s.markers);
  const { create, update, remove } = useMarkerActions(song.id);
  const { canEdit } = useMarkerPermissions(song);
  const type = existing?.type ?? (editor.mode === "create" ? editor.type : "section");
  const presetLabel = (p: (typeof SECTION_PRESETS)[number]) => t(`markers.presets.${p}`);
  const initialName =
    existing?.name ?? (type === "section" ? numberedName(presetLabel("verse"), markers) : "");
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<PaletteColor>(
    existing?.color ?? (type === "section" ? SECTION_PRESET_COLORS.verse : "yellow"),
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const hasTempo = useTempoUi((s) => s.grid !== null);
  const [musical, setMusical] = useState(
    hasTempo && (existing ? existing.anchor === "musical" : anchorNow() === "musical"),
  );
  const range: Range =
    editor.mode === "create"
      ? editor.range
      : { start: existing?.startSec ?? 0, end: existing?.endSec ?? existing?.startSec ?? 0 };
  const [start, setStart] = useState(formatClock(range.start));
  const [end, setEnd] = useState(formatClock(range.end));
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const title =
    editor.mode === "create"
      ? t(type === "section" ? "markers.newSection" : "markers.newMarker")
      : t(type === "section" ? "markers.editSection" : "markers.editMarker");

  const save = async () => {
    const form = validateMarkerForm(type, { name, start, end });
    if (!form.ok) {
      setError(t(form.error));
      return;
    }
    const { name: trimmed, startSec: s, endSec: e } = form;
    closeEditor();
    if (existing) {
      await update(existing, {
        name: trimmed,
        color,
        note: note.trim(),
        startSec: s,
        ...(type === "section" && e !== null && { endSec: e }),
        ...(hasTempo && { anchor: musical ? "musical" : "time" }),
      });
      if (type === "section" && e !== null && useTimelineUi.getState().picked === existing.id)
        setSelection({ start: s, end: e }, existing.id);
    } else {
      const m = await create({
        type,
        name: trimmed,
        color,
        note: note.trim(),
        startSec: s,
        ...(type === "section" && { endSec: e }),
        anchor: hasTempo && musical ? "musical" : "time",
      });
      if (m?.type === "section" && m.endSec !== null)
        setSelection({ start: m.startSec, end: m.endSec }, m.id);
    }
  };

  return (
    <Modal opened onClose={closeEditor} title={title} centered data-testid="marker-editor">
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <Stack>
          {type === "section" && (
            <Chip.Group>
              <Group gap={6} data-testid="section-presets">
                {SECTION_PRESETS.map((p) => (
                  <Chip
                    key={p}
                    size="sm"
                    color={SECTION_PRESET_COLORS[p]}
                    checked={presetForName(name, presetLabel) === p}
                    onChange={() => {
                      setName(
                        numberedName(
                          presetLabel(p),
                          markers.filter((m) => m.id !== existing?.id),
                        ),
                      );
                      setColor(presetColor(p, color));
                      nameRef.current?.focus();
                    }}
                  >
                    {presetLabel(p)}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          )}
          <TextInput
            ref={nameRef}
            label={t("markers.name")}
            value={name}
            maxLength={60}
            data-autofocus
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
            data-testid="marker-name"
          />
          <ColorSwatchPicker label={t("markers.color")} value={color} onChange={setColor} />
          <Group grow>
            <TextInput
              label={type === "section" ? t("markers.start") : t("markers.position")}
              value={start}
              onChange={(e) => {
                setStart(e.currentTarget.value);
              }}
              className="tabular-nums"
              data-testid="marker-start"
            />
            {type === "section" && (
              <TextInput
                label={t("markers.end")}
                value={end}
                onChange={(e) => {
                  setEnd(e.currentTarget.value);
                }}
                className="tabular-nums"
                data-testid="marker-end"
              />
            )}
          </Group>
          {hasTempo && (
            <Switch
              label={t("markers.anchorMusical")}
              description={t("markers.anchorMusicalHint")}
              checked={musical}
              onChange={(ev) => {
                setMusical(ev.currentTarget.checked);
              }}
              data-testid="marker-anchor"
            />
          )}
          <Textarea
            label={t("markers.note")}
            value={note}
            maxLength={500}
            autosize
            minRows={1}
            maxRows={4}
            onChange={(e) => {
              setNote(e.currentTarget.value);
            }}
          />
          {error && (
            <Text c="red" size="sm">
              {error}
            </Text>
          )}
          <Group justify="space-between">
            {existing && canEdit(existing) ? (
              <Button
                variant="subtle"
                color="red"
                h={44}
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  closeEditor();
                  if (useTimelineUi.getState().picked === existing.id) clearSelection();
                  void remove(existing);
                }}
                data-testid="marker-delete"
              >
                {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <Group gap="xs">
              <Button variant="default" h={44} onClick={closeEditor}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" h={44} data-testid="marker-save">
                {t("common.save")}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
