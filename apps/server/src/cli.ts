import { promptTerminal, readAllStdin } from "./prompt";
import { runCli } from "./runCli";

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  out: console.log,
  err: console.error,
  prompt: promptTerminal,
  readStdin: readAllStdin,
});
