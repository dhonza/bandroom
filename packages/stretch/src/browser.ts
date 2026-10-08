import { StretchModule } from "./module";

let loading: Promise<StretchModule> | null = null;

/** Loads stretch.wasm once (bundled as an asset next to the worker; precached by the PWA). */
export function loadStretch(): Promise<StretchModule> {
  loading ??= fetch(new URL("./stretch.wasm", import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`stretch.wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((bytes) => StretchModule.instantiate(bytes))
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}
