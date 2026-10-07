import { splitMentions } from "@bandroom/shared";
import { Anchor, Box, Code, Text } from "@mantine/core";
import { useMemo } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** The markdown subset of SPEC §8: bold, italic, links, inline code, lists, line breaks. */
const ALLOWED = ["p", "strong", "em", "del", "a", "code", "ul", "ol", "li", "br", "span"];

const schema = {
  ...defaultSchema,
  tagNames: ALLOWED,
  attributes: { ...defaultSchema.attributes, a: ["href"], span: [] },
  protocols: { href: ["http", "https", "mailto"] },
};

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Wraps `@username` of known users in a highlighted span. Runs after sanitizing, on text nodes
 * outside links and code only.
 */
function rehypeMentions(known: ReadonlySet<string>) {
  const walk = (node: HastNode) => {
    if (!node.children || node.tagName === "a" || node.tagName === "code") return;
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type !== "text" || !child.value?.includes("@")) {
        walk(child);
        return [child];
      }
      return splitMentions(child.value, known).map((p) =>
        p.mention
          ? {
              type: "element",
              tagName: "span",
              properties: { dataMention: "true" },
              children: [{ type: "text", value: p.text }],
            }
          : { type: "text", value: p.text },
      );
    });
  };
  return () => (tree: HastNode) => {
    walk(tree);
  };
}

const remarkPlugins = [remarkGfm];
type PluggableList = NonNullable<Options["rehypePlugins"]>;

const components: Components = {
  p: ({ children }) => (
    <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} mb={4}>
      {children}
    </Text>
  ),
  a: ({ href, children }) => (
    <Anchor href={href} target="_blank" rel="noopener noreferrer nofollow" size="sm">
      {children}
    </Anchor>
  ),
  code: ({ children }) => <Code>{children}</Code>,
  ul: ({ children }) => (
    <Box component="ul" my={4} pl="lg" fz="sm">
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box component="ol" my={4} pl="lg" fz="sm">
      {children}
    </Box>
  ),
  span: ({ children, ...rest }) =>
    "data-mention" in rest ? (
      <Text span fw={700} c="blue" data-testid="comment-mention">
        {children}
      </Text>
    ) : (
      <span>{children}</span>
    ),
};

/** Renders a comment body: sanitized markdown subset with highlighted mentions (SPEC §8). */
export function CommentBody({ body, usernames }: { body: string; usernames: readonly string[] }) {
  const known = useMemo(() => new Set(usernames.map((u) => u.toLowerCase())), [usernames]);
  const rehypePlugins = useMemo(
    () => [[rehypeSanitize, schema] as const, rehypeMentions(known)] as PluggableList,
    [known],
  );
  return (
    <Box data-testid="comment-body">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        allowedElements={ALLOWED}
        unwrapDisallowed
      >
        {body}
      </Markdown>
    </Box>
  );
}
