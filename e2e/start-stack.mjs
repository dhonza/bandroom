// Starts the built API server and worker together for Playwright, and stops both on exit.
// With SAMPLY_MOCK_PORT set, also a Samply API mock that the server imports from.
import { spawn } from "node:child_process";
import { startSamplyMock } from "./samply-mock.mjs";

const mock = process.env.SAMPLY_MOCK_PORT
  ? startSamplyMock(Number(process.env.SAMPLY_MOCK_PORT))
  : null;
const env = {
  ...process.env,
  INTERNAL_API_URL: `http://127.0.0.1:${process.env.PORT}`,
  ...(mock ? { SAMPLY_API_URL: mock.url } : {}),
};
const procs = [
  spawn(process.execPath, ["apps/server/dist/main.js"], { env, stdio: "inherit" }),
  spawn(process.execPath, ["apps/worker/dist/main.js"], { env, stdio: "inherit" }),
];
const stop = () => {
  mock?.close();
  for (const p of procs) p.kill("SIGTERM");
};
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
for (const p of procs)
  p.on("exit", (code) => {
    stop();
    process.exit(code ?? 1);
  });
