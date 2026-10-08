# Vendored sources

Unmodified copies of two MIT-licensed header-only libraries by Signalsmith Audio. Each folder keeps its `LICENSE.txt`.

| Folder                 | Upstream                                                 | Version     | Commit                                     |
| ---------------------- | -------------------------------------------------------- | ----------- | ------------------------------------------ |
| `signalsmith-stretch/` | https://github.com/Signalsmith-Audio/signalsmith-stretch | tag `1.4.0` | `a670068d9aeb64913331d5cc29337b19a457a7df` |
| `signalsmith-linear/`  | https://github.com/Signalsmith-Audio/linear              | tag `0.6.4` | `de55e6a50ffcf6f8f43f649692d94691c7025151` |

Only the headers were copied: no tests, build files or web demo. To update, replace the files from a new tag, update this table, run `pnpm stretch:build` and commit the new `src/stretch.wasm` and its hash.
