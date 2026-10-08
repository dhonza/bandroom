import { readFile } from "node:fs/promises";
import { StretchModule } from "./module";

let loading: Promise<StretchModule> | null = null;

/**
 * Loads stretch.wasm once. In the bundled server/worker the build copies it next to the bundle,
 * so the same relative URL works from the sources and from `dist/`.
 */
export function loadStretch(): Promise<StretchModule> {
  loading ??= readFile(new URL("./stretch.wasm", import.meta.url))
    .then((bytes) => StretchModule.instantiate(bytes))
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}
