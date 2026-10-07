import { COMMENT_BODY_MAX, mentionQueryAt, type MentionableUser } from "@bandroom/shared";
import { Button, Group, Paper, Stack, Text, Textarea, UnstyledButton } from "@mantine/core";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMentionable } from "./queries";

const MAX_SUGGESTIONS = 5;

/** Users matching the `@` query by username or display name. */
export function matchMentionable(
  users: readonly MentionableUser[],
  query: string,
): MentionableUser[] {
  const q = query.toLowerCase();
  return users
    .filter(
      (u) =>
        u.username.startsWith(q) ||
        u.displayName
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.startsWith(q)),
    )
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * Comment text with `@` autocomplete from the users who can view the song (SPEC §8). Enter or
 * Tab picks the first suggestion; Ctrl/⌘+Enter submits.
 */
export function CommentEditor({
  songId,
  initial = "",
  submitLabel,
  onSubmit,
  onCancel,
  testId = "comment-input",
}: {
  songId: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<boolean>;
  onCancel?: () => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const users = useMentionable(songId, true).data?.users ?? [];
  const mention = mentionQueryAt(text, caret);
  const suggestions =
    mention && mention.start !== dismissed ? matchMentionable(users, mention.query) : [];
  const trimmed = text.trim();

  const pick = (u: MentionableUser) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(caret);
    const insert = `@${u.username} `;
    const next = `${before}${insert}${after}`;
    const pos = before.length + insert.length;
    pendingCaret.current = pos;
    setText(next);
    setCaret(pos);
  };
  // Put the caret after an inserted mention right after React commits the new value.
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    if (pos === null) return;
    pendingCaret.current = null;
    ref.current?.focus();
    ref.current?.setSelectionRange(pos, pos);
  }, [text]);

  const submit = async () => {
    if (!trimmed || trimmed.length > COMMENT_BODY_MAX || busy) return;
    setBusy(true);
    const ok = await onSubmit(trimmed);
    setBusy(false);
    if (ok) {
      setText("");
      setCaret(0);
    }
  };

  return (
    <Stack gap={6}>
      <Textarea
        ref={ref}
        value={text}
        autosize
        minRows={2}
        maxRows={10}
        maxLength={COMMENT_BODY_MAX}
        placeholder={t("comments.placeholder")}
        aria-label={t("comments.text")}
        data-autofocus
        data-testid={testId}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setCaret(e.currentTarget.selectionStart);
          setDismissed(null);
        }}
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart);
        }}
        onKeyDown={(e) => {
          const first = suggestions[0];
          if (first && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            pick(first);
          } else if (suggestions.length > 0 && e.key === "Escape") {
            e.stopPropagation();
            setDismissed(mention?.start ?? null);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {suggestions.length > 0 && (
        <Paper withBorder p={4} role="listbox" data-testid="mention-suggestions">
          {suggestions.map((u) => (
            <UnstyledButton
              key={u.id}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the textarea focused
              }}
              onClick={() => {
                pick(u);
              }}
              style={{ display: "flex", alignItems: "center", minHeight: 44, width: "100%" }}
              px="xs"
              data-testid="mention-option"
            >
              <Text size="sm" fw={600} mr={6}>
                {u.displayName}
              </Text>
              <Text size="sm" c="dimmed">
                @{u.username}
              </Text>
            </UnstyledButton>
          ))}
        </Paper>
      )}
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="xs" c={text.length > COMMENT_BODY_MAX - 200 ? "orange" : "dimmed"}>
          {t("comments.markdownHint")}
          {text.length > COMMENT_BODY_MAX - 200 && ` · ${text.length}/${COMMENT_BODY_MAX}`}
        </Text>
        <Group gap="xs" wrap="nowrap">
          {onCancel && (
            <Button variant="default" h={44} onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
          <Button
            h={44}
            loading={busy}
            disabled={!trimmed}
            onClick={() => void submit()}
            data-testid={`${testId}-submit`}
          >
            {submitLabel}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
