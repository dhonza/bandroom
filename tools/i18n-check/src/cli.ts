import fs from "node:fs";
import path from "node:path";
import { compareLocale, type Issue, type Messages } from "./check";

const LOCALES_DIR = path.resolve(import.meta.dirname, "../../../apps/web/src/locales");
const REFERENCE = "en";

function readJson(file: string): Messages {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Messages;
}

const locales = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const namespaces = fs
  .readdirSync(path.join(LOCALES_DIR, REFERENCE))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const issues: Issue[] = [];
for (const locale of locales.filter((l) => l !== REFERENCE)) {
  for (const ns of namespaces) {
    const file = path.join(LOCALES_DIR, locale, `${ns}.json`);
    if (!fs.existsSync(file)) {
      issues.push({ locale, namespace: ns, key: "*", problem: "namespace file missing" });
      continue;
    }
    issues.push(
      ...compareLocale(
        ns,
        { locale: REFERENCE, messages: readJson(path.join(LOCALES_DIR, REFERENCE, `${ns}.json`)) },
        { locale, messages: readJson(file) },
      ),
    );
  }
}

if (issues.length > 0) {
  for (const i of issues) console.error(`✗ ${i.locale}/${i.namespace}: ${i.key} — ${i.problem}`);
  console.error(`\n${issues.length} i18n issue(s).`);
  process.exit(1);
}
console.log(`i18n OK: ${locales.join(", ")} × ${namespaces.join(", ")}`);
