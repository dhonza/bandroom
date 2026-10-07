import { Anchor, Box } from "@mantine/core";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * GitHub-style Markdown for documents (SPEC §10), sanitized (SPEC §18.6). Images are dropped:
 * the CSP allows only our own origin, and remote images would leak who reads the document.
 */
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img" && t !== "picture"),
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeSanitize, schema] as const] as NonNullable<
  Parameters<typeof Markdown>[0]["rehypePlugins"]
>;

const components: Components = {
  a: ({ href, children }) => (
    <Anchor href={href} target="_blank" rel="noopener noreferrer nofollow" inherit>
      {children}
    </Anchor>
  ),
};

export function MarkdownBody({ text, fontSize }: { text: string; fontSize?: number }) {
  return (
    <Box className="doc-markdown" style={{ fontSize }} data-testid="doc-markdown">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </Markdown>
    </Box>
  );
}

/** Plain text (and ChordPro for now) in monospace, spacing preserved (SPEC §10). */
export function PlainTextBody({ text, fontSize }: { text: string; fontSize?: number }) {
  return (
    <Box component="pre" className="doc-plaintext" style={{ fontSize }} data-testid="doc-text">
      {text}
    </Box>
  );
}
