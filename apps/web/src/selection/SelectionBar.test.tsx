import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n/i18n";
import { SelectionBar } from "./SelectionBar";

const i18n = i18next.createInstance();

describe("SelectionBar (SPEC §26.1)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });

  const renderBar = (allowed: number, onClick = vi.fn(), onExit = vi.fn(), onAll = vi.fn()) => {
    render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <SelectionBar
            count={3}
            total={5}
            onSelectAll={onAll}
            onExit={onExit}
            actions={[
              {
                key: "delete",
                label: "Delete",
                icon: null,
                allowed,
                reason: "1 is not yours",
                onClick,
              },
            ]}
          />
        </MantineProvider>
      </I18nextProvider>,
    );
    return { onClick, onExit, onAll };
  };

  it("shows the count, the allowed part and why the rest is left out", async () => {
    const { onClick, onAll } = renderBar(2);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 selected");
    const del = screen.getByTestId("selection-delete");
    expect(del).toHaveTextContent("Delete (2)");
    expect(screen.getByTestId("selection-reason-delete")).toHaveTextContent("1 is not yours");
    await userEvent.click(del);
    expect(onClick).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId("selection-all"));
    expect(onAll).toHaveBeenCalledOnce();
  });

  it("disables an action no selected item allows, with the reason", () => {
    renderBar(0);
    expect(screen.getByTestId("selection-delete")).toBeDisabled();
    expect(screen.getByTestId("selection-reason-none")).toHaveTextContent("1 is not yours");
  });

  it("Esc and the close button end the selection", async () => {
    const { onExit } = renderBar(3);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("selection-exit"));
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("an action can open a menu; Esc there closes only the menu", async () => {
    const copy = vi.fn();
    const onExit = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <SelectionBar
            count={2}
            total={2}
            onSelectAll={vi.fn()}
            onExit={onExit}
            actions={[
              {
                key: "copyMove",
                label: "Copy or move",
                icon: null,
                allowed: 2,
                onClick: vi.fn(),
                menu: [
                  { key: "copyTo", label: "Copy to…", allowed: 2, onClick: copy },
                  { key: "moveTo", label: "Move to…", allowed: 0, onClick: vi.fn() },
                ],
              },
            ]}
          />
        </MantineProvider>
      </I18nextProvider>,
    );
    await userEvent.click(screen.getByTestId("selection-copyMove"));
    expect(await screen.findByTestId("selection-moveTo")).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onExit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("selection-copyMove"));
    await userEvent.click(await screen.findByTestId("selection-copyTo"));
    expect(copy).toHaveBeenCalledOnce();
  });
});
