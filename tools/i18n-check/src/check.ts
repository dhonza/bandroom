/**
 * Verifies that every locale has the same keys as the reference locale (`en`), with plural keys
 * checked against each language's own CLDR plural categories (SPEC §12), and that interpolation
 * variables match.
 */

export type Messages = { [key: string]: string | Messages };
export type Issue = { locale: string; namespace: string; key: string; problem: string };

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const;
const PLURAL_RE = new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join("|")})$`);

export function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(messages)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

export function pluralCategories(locale: string): string[] {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

function variables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1] ?? "").sort();
}

/** Groups keys: plural families become `base → {category → text}`; others stay single. */
function group(flat: Map<string, string>): {
  singles: Map<string, string>;
  plurals: Map<string, Map<string, string>>;
} {
  const singles = new Map<string, string>();
  const plurals = new Map<string, Map<string, string>>();
  for (const [key, text] of flat) {
    const m = PLURAL_RE.exec(key);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const family = plurals.get(m[1]) ?? new Map<string, string>();
      family.set(m[2], text);
      plurals.set(m[1], family);
    } else {
      singles.set(key, text);
    }
  }
  return { singles, plurals };
}

export function compareLocale(
  namespace: string,
  reference: { locale: string; messages: Messages },
  target: { locale: string; messages: Messages },
): Issue[] {
  const issues: Issue[] = [];
  const add = (key: string, problem: string) =>
    issues.push({ locale: target.locale, namespace, key, problem });

  const ref = group(flatten(reference.messages));
  const tgt = group(flatten(target.messages));

  for (const [key, text] of ref.singles) {
    const t = tgt.singles.get(key);
    if (t === undefined) add(key, "missing");
    else if (variables(t).join() !== variables(text).join()) add(key, "interpolation mismatch");
  }
  for (const key of tgt.singles.keys()) {
    if (!ref.singles.has(key)) add(key, "extra (not in reference)");
  }

  const required = pluralCategories(target.locale);
  for (const [base, refFamily] of ref.plurals) {
    const family = tgt.plurals.get(base);
    const refVars = variables(refFamily.get("other") ?? "").join();
    for (const cat of required) {
      const t = family?.get(cat);
      if (t === undefined) add(`${base}_${cat}`, "missing plural form");
      else if (variables(t).join() !== refVars) add(`${base}_${cat}`, "interpolation mismatch");
    }
  }
  for (const [base, family] of tgt.plurals) {
    if (!ref.plurals.has(base)) {
      add(`${base}_*`, "extra plural family (not in reference)");
      continue;
    }
    for (const cat of family.keys()) {
      if (!required.includes(cat))
        add(`${base}_${cat}`, `plural form not used by ${target.locale}`);
    }
  }
  return issues;
}
