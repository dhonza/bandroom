import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody, PlainTextBody } from "./MarkdownBody";

const renderIn = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);

describe("document Markdown (SPEC §10, §18.6)", () => {
  it("renders GitHub Markdown: headings, tables, task lists, links in a new tab", () => {
    renderIn(
      <MarkdownBody
        text={
          "# Verse\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n[site](https://example.org)"
        }
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Verse");
    expect(screen.getAllByRole("cell").map((c) => c.textContent)).toEqual(["1", "2"]);
    expect(screen.getByRole("checkbox")).toBeDefined();
    const link = screen.getByRole("link", { name: "site" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("drops scripts, event handlers, javascript: links and images", () => {
    const { container } = renderIn(
      <MarkdownBody
        text={
          '<script>alert(1)</script>\n\n<b onclick="alert(1)">bold</b>\n\n[x](javascript:alert(1))\n\n![pic](https://tracker.example/p.png)\n\n<iframe src="https://x"></iframe>'
        }
      />,
    );
    expect(container.querySelector("script, iframe, img")).toBeNull();
    expect(container.innerHTML).not.toContain("onclick");
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("keeps plain text spacing (chords over lyrics)", () => {
    renderIn(<PlainTextBody text={"Am      C\nla  la  la"} />);
    expect(screen.getByTestId("doc-text").textContent).toBe("Am      C\nla  la  la");
  });
});
