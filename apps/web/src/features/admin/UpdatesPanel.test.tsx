import type { UpdatesState } from "@bandroom/shared";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/i18n";
import { makeUser, mockApi } from "../../test/mockApi";
import { UpdatesPanel } from "./UpdatesPanel";

const i18n = i18next.createInstance();

const STATE: UpdatesState = {
  running: "v0.5.0",
  available: ["v0.6.0", "v0.5.0", "v0.4.0"],
  checkedAt: Date.now() - 5 * 60_000,
  imageRepo: "dhonza/bandroom",
  request: null,
  lastResult: null,
  hostStatusAt: Date.now() - 60_000,
};
const REQUEST = {
  id: "0192f000-0000-7000-8000-000000000001",
  action: "deploy" as const,
  tag: "v0.6.0",
  requestedBy: "boss",
  ts: Date.now() - 30_000,
  state: "pending" as const,
};
const USERS = {
  users: [
    {
      ...makeUser({ username: "boss", displayName: "Big Boss" }),
      disabledAt: null,
      lastSeenAt: null,
      resetRequestedAt: null,
      quotaBytes: null,
      usedBytes: 0,
    },
  ],
};

function renderPanel() {
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <UpdatesPanel pollMs={30} watchMs={2000} />
        </QueryClientProvider>
      </MantineProvider>
    </I18nextProvider>,
  );
}

const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");
/** The `check` query of every GET /admin/updates so far. */
const checks = (fetch: ReturnType<typeof mockApi>) =>
  fetch.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((u) => u.pathname.endsWith("/admin/updates"))
    .map((u) => u.searchParams.get("check"));

describe("UpdatesPanel (SPEC §29.8)", () => {
  beforeAll(async () => {
    await initI18n("en", i18n);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the running version and offers Deploy only on newer releases", async () => {
    const fetch = mockApi({
      "GET /admin/updates": () => ({ body: STATE }),
      "GET /admin/users": () => ({ body: USERS }),
    });
    renderPanel();
    expect(await screen.findByTestId("updates-running")).toHaveTextContent("v0.5.0");
    const rows = screen.getAllByTestId("updates-release");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("v0.6.0"),
      expect.stringContaining("v0.5.0"),
      expect.stringContaining("v0.4.0"),
    ]);
    const [newer, current, older] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(newer).getByRole("button", { name: "Deploy v0.6.0" })).toBeInTheDocument();
    expect(within(current).getByText("Running")).toBeInTheDocument();
    expect(within(current).queryByRole("button")).toBeNull();
    expect(within(older).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("updates-checked")).toHaveTextContent("5 minutes ago");
    expect(screen.queryByTestId("updates-watcher-warning")).toBeNull();
    expect(checks(fetch)).toEqual(["true"]);

    await userEvent.click(screen.getByTestId("updates-check"));
    await waitFor(() => {
      expect(checks(fetch)).toEqual(["true", "force"]);
    });
  });

  it("warns when the host watcher has not reported", async () => {
    mockApi({
      "GET /admin/updates": () => ({ body: { ...STATE, hostStatusAt: null } }),
      "GET /admin/users": () => ({ body: USERS }),
    });
    renderPanel();
    expect(await screen.findByTestId("updates-watcher-warning")).toHaveTextContent(
      "hasn't reported",
    );
  });

  it("still shows the running version when the registry check fails", async () => {
    mockApi({
      "GET /admin/updates": () => ({ body: { ...STATE, available: null, checkedAt: null } }),
      "GET /admin/users": () => ({ body: USERS }),
    });
    // The first (check=true) call fails, the fallback (check=false) answers.
    const inner = globalThis.fetch;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      (input instanceof Request ? input.url : String(input)).includes("check=true")
        ? Promise.resolve(
            Response.json({ code: "UPDATE_CHECK_FAILED", message: "x" }, { status: 502 }),
          )
        : inner(input, init),
    );
    vi.stubGlobal("fetch", fetch);
    renderPanel();
    expect(await screen.findByTestId("updates-running")).toHaveTextContent("v0.5.0");
    expect(screen.getByTestId("updates-check-error")).toHaveTextContent(
      "Could not check for updates.",
    );
    expect(screen.getByTestId("updates-checked")).toHaveTextContent("not checked");
  });

  it("asks for confirmation before deploying", async () => {
    const posts: unknown[] = [];
    mockApi({
      "GET /admin/updates": () => ({ body: STATE }),
      "GET /admin/users": () => ({ body: USERS }),
      "POST /admin/updates": (init) => {
        posts.push(bodyOf(init));
        return { body: { request: REQUEST } };
      },
    });
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Deploy v0.6.0" }));
    expect(await screen.findByText(/database backup/)).toBeInTheDocument();
    expect(posts).toEqual([]);
    await userEvent.click(screen.getByTestId("updates-deploy-confirm"));
    await waitFor(() => {
      expect(posts).toEqual([{ action: "deploy", tag: "v0.6.0" }]);
    });
  });

  it("enables Rollback only when the running version is typed exactly", async () => {
    const posts: unknown[] = [];
    mockApi({
      "GET /admin/updates": () => ({ body: STATE }),
      "GET /admin/users": () => ({ body: USERS }),
      "POST /admin/updates": (init) => {
        posts.push(bodyOf(init));
        return { body: { request: { ...REQUEST, action: "rollback", tag: null } } };
      },
    });
    renderPanel();
    await userEvent.click(await screen.findByTestId("updates-rollback"));
    const confirm = await screen.findByTestId("updates-rollback-confirm");
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId("updates-rollback-input"), "v0.5");
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId("updates-rollback-input"), ".0");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(posts).toEqual([{ action: "rollback", confirmRunningVersion: "v0.5.0" }]);
    });
  });

  it("can cancel only a pending request", async () => {
    let request: typeof REQUEST | (Omit<typeof REQUEST, "state"> & { state: "running" }) = {
      ...REQUEST,
      state: "running",
    };
    let deletes = 0;
    mockApi({
      "GET /admin/updates": () => ({ body: { ...STATE, request } }),
      "GET /admin/users": () => ({ body: USERS }),
      "DELETE /admin/updates": () => {
        deletes++;
        return { body: { ok: true } };
      },
    });
    renderPanel();
    const card = await screen.findByTestId("updates-request");
    expect(card).toHaveTextContent("Deploy v0.6.0");
    await waitFor(() => {
      expect(card).toHaveTextContent("Requested by Big Boss");
    });
    expect(within(card).getByRole("button", { name: "Cancel request" })).toBeDisabled();
    // Deploy and Rollback wait while a request exists.
    expect(screen.getByRole("button", { name: "Deploy v0.6.0" })).toBeDisabled();
    expect(screen.getByTestId("updates-rollback")).toBeDisabled();

    request = { ...REQUEST };
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel request" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => {
      expect(deletes).toBe(1);
    });
  });

  it("follows a deploy through the restart to the new version", async () => {
    let phase: "pending" | "restarting" | "done" = "pending";
    mockApi({
      "GET /admin/updates": () =>
        phase === "pending"
          ? { body: { ...STATE, request: REQUEST } }
          : phase === "restarting"
            ? { status: 502, body: { code: "UNKNOWN", message: "bad gateway" } }
            : {
                body: {
                  ...STATE,
                  running: "v0.6.0",
                  lastResult: {
                    id: REQUEST.id,
                    action: "deploy",
                    tag: "v0.6.0",
                    exitCode: 0,
                    startedAt: Date.now() - 60_000,
                    finishedAt: Date.now(),
                    error: null,
                    outputTail: "Starting v0.6.0\nhealthy",
                  },
                },
              },
      "GET /admin/users": () => ({ body: USERS }),
    });
    renderPanel();
    expect(await screen.findByTestId("updates-request")).toBeInTheDocument();
    phase = "restarting";
    expect(await screen.findByTestId("updates-restarting")).toHaveTextContent(
      "The app is restarting",
    );
    expect(screen.getByTestId("updates-running")).toHaveTextContent("v0.5.0");
    phase = "done";
    expect(await screen.findByTestId("updates-now-running")).toHaveTextContent(
      "Now running v0.6.0.",
    );
    expect(screen.queryByTestId("updates-restarting")).toBeNull();
    const result = screen.getByTestId("updates-last-result");
    expect(result).toHaveTextContent("Succeeded");
    await userEvent.click(within(result).getByRole("button", { name: "Show output" }));
    expect(await within(result).findByText(/healthy/)).toBeInTheDocument();
  });

  it("stops polling when nothing is requested", async () => {
    const fetch = mockApi({
      "GET /admin/updates": () => ({ body: STATE }),
      "GET /admin/users": () => ({ body: USERS }),
    });
    renderPanel();
    await screen.findByTestId("updates-running");
    await new Promise((r) => setTimeout(r, 150));
    expect(checks(fetch)).toEqual(["true"]);
  });

  it("shows a failed result with its error", async () => {
    mockApi({
      "GET /admin/updates": () => ({
        body: {
          ...STATE,
          lastResult: {
            id: REQUEST.id,
            action: "rollback",
            tag: null,
            exitCode: 1,
            startedAt: null,
            finishedAt: null,
            error: "no backup",
            outputTail: "",
          },
        },
      }),
      "GET /admin/users": () => ({ body: USERS }),
    });
    renderPanel();
    const result = await screen.findByTestId("updates-last-result");
    expect(result).toHaveTextContent("Rollback");
    expect(result).toHaveTextContent("Failed (exit code 1)");
    expect(result).toHaveTextContent("no backup");
  });
});
