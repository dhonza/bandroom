// WebAssembly is a global in Node, but @types/node does not declare it (TypeScript has it only in
// lib.dom / lib.webworker, which server code does not load). Just what the loader of
// `@bandroom/stretch` uses (SPEC §30.7: the bounce runs the same WASM in the worker). Referenced
// from `stretchInput.ts` (a type-only import), so every program that bundles the stretcher sees it.

export {};

declare global {
  type BufferSource = ArrayBufferView | ArrayBuffer;

  namespace WebAssembly {
    interface Memory {
      readonly buffer: ArrayBuffer;
    }
    type Imports = Record<string, Record<string, unknown>>;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Module {}
    // eslint-disable-next-line no-var
    var Module: { prototype: Module; new (bytes: BufferSource): Module };
    interface Instance {
      readonly exports: Record<string, unknown>;
    }
    function compile(bytes: BufferSource): Promise<Module>;
    function instantiate(module: Module, imports?: Imports): Promise<Instance>;
  }
}
