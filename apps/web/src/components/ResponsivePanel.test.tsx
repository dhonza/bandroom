import { Button, MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "../i18n/i18n";
import { setPhoneViewport } from "../test/setup";
import { AppModal, CaptionButton, PanelPopover } from "./ResponsivePanel";

const i18n = i18next.createInstance();

function wrap(ui: React.ReactNode) {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>{ui}</MantineProvider>
    </I18nextProvider>,
  );
}

function Controlled() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span data-testid="state">{String(open)}</span>
      <PanelPopover
        opened={open}
        onChange={setOpen}
        title="Panel"
        target={
          <Button
            onClick={() => {
              setOpen((o) => !o);
            }}
          >
            Open
          </Button>
        }
        testId="panel"
      >
        <span>Body</span>
      </PanelPopover>
    </>
  );
}

describe("ResponsivePanel", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    setPhoneViewport(false);
  });

  it("AppModal is full screen with a labelled close button on phones", async () => {
    setPhoneViewport(true);
    wrap(
      <AppModal opened onClose={() => undefined} title="Settings" data-testid="m">
        <span>Content</span>
      </AppModal>,
    );
    expect(await screen.findByText("Content")).toBeInTheDocument();
    expect(document.querySelector("[data-sheet='true']")).not.toBeNull();
    expect(document.querySelector(".mantine-Modal-root[data-full-screen]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("AppModal stays a normal modal on desktop", async () => {
    wrap(
      <AppModal opened onClose={() => undefined} title="Settings" centered>
        <span>Content</span>
      </AppModal>,
    );
    expect(await screen.findByText("Content")).toBeInTheDocument();
    expect(document.querySelector("[data-sheet='true']")).toBeNull();
    expect(document.querySelector("[data-full-screen]")).toBeNull();
  });

  it("PanelPopover opens a popover on desktop", async () => {
    const user = userEvent.setup();
    wrap(
      <PanelPopover title="Panel" target={<Button>Open</Button>} testId="panel">
        <span>Body</span>
      </PanelPopover>,
    );
    const target = screen.getByRole("button", { name: "Open" });
    expect(target).toHaveAttribute("aria-expanded", "false");
    await user.click(target);
    expect(await screen.findByTestId("panel")).toHaveClass("mantine-Popover-dropdown");
    expect(screen.queryByText("Panel")).toBeNull();
    expect(target).toHaveAttribute("aria-expanded", "true");
  });

  it("PanelPopover opens a full-screen modal with the title on phones", async () => {
    setPhoneViewport(true);
    const user = userEvent.setup();
    wrap(
      <PanelPopover
        title="Panel"
        target={(props) => <Button {...props}>Open</Button>}
        testId="panel"
      >
        <span>Body</span>
      </PanelPopover>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Body")).toBeInTheDocument();
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(document.querySelector("[data-sheet='true']")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Open", hidden: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("PanelPopover follows a controlled state", async () => {
    setPhoneViewport(true);
    const user = userEvent.setup();
    wrap(<Controlled />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByTestId("state")).toHaveTextContent("true");
    expect(await screen.findByText("Body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("state")).toHaveTextContent("false");
  });

  it("CaptionButton shows an icon with a caption and its state", async () => {
    const user = userEvent.setup();
    let clicks = 0;
    wrap(
      <CaptionButton
        icon={<span>i</span>}
        caption="Mixer"
        active
        aria-pressed
        onClick={() => {
          clicks++;
        }}
        data-testid="cb"
      />,
    );
    const b = screen.getByTestId("cb");
    expect(b).toHaveTextContent("Mixer");
    expect(b).toHaveAttribute("aria-pressed", "true");
    expect(b).toHaveAttribute("data-variant", "filled");
    await user.click(b);
    expect(clicks).toBe(1);
  });
});
