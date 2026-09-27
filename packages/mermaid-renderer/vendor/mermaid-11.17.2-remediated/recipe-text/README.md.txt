# Mermaid 11.17.2 Narrow Rebuild

Review candidate, not an upstream-official release. The source tag is
`mermaid@11.17.2`, commit `dcb694ddb58dc5ad3502e7e903cac05fd812eac3`.
No upstream source module or shared OpenClaw file is edited.

## Inputs

`package.json` and `pnpm-lock.yaml` contain a closed 205-pin build graph derived
from that commit's lock, including all platform alternatives. Exact changes:

- DOMPurify 3.4.12 -> 3.4.16 (the specifically authorized release-age exception).
- KaTeX 0.16.47 -> 0.18.2; public `renderToString` usage must pass behavior proof.
- js-yaml 4.3.0 -> 4.3.2 (both build tooling and shipped runtime).
- fast-uri 3.1.0 -> 3.1.8 (AJV build-time dependency).
- underscore 1.1.7 -> 1.13.8 (Jison/nomnom build-time dependency; crosses the old
  declared range, so successful grammar generation and render tests are required).
- All lodash-es edges use 4.18.1, already present in the source lock. This avoids
  reintroducing the older copy embedded in published parser 1.2.1.

The existing roughjs patch is copied byte-for-byte. It changes a TypeScript
declaration export, not runtime behavior. Deprecated nomnom 1.5.2 remains an
upstream build-only input. No dependency lifecycle hooks are allowed. Do not run
the monorepo's `prepare`, `build`, or `build:mermaid` scripts.

Generate the same-version parser from the exact source grammars with the pinned
Langium CLI 4.2.1. An esbuild alias points `@mermaid-js/parser` to that generated
source, not the published opaque parser bundle. All other renderer source and
upstream IIFE build options are unchanged. Esbuild is 0.25.12 and tsx is 4.20.6.
This is a JavaScript asset build, not a full monorepo typecheck or release.

## Recipe

Before installation, independently approve the complete graph, registry metadata,
release ages, signatures, advisory scan, exact archive bytes and lifecycle policy.
Minimal replacement receipts do not clear this complete graph or compiled output.
Use a secretless environment and an isolated HOME, cache and store. Run build code
with no network and no access to user state. Node/toolchain versions are recorded
in output; this host has Node 26.9.0, versus upstream's Node 24.16.0.

1. Run `node remediation/prepare.mjs /absolute/new/build-directory` from this
   checkout. It verifies every source file against its exact Git blob and copies the reviewed
   build manifest, lock, patch and driver. The build directory must be new and
   outside the checkout. It does not install or execute dependencies.
2. In that directory, invoke the already-audited native pnpm 12.4.0 binary after
   checking its runtime version, with `install --pm-on-fail=ignore --frozen-lockfile
   --ignore-scripts --offline --store-dir /absolute/isolated/store`. The standalone
   `pnpm-workspace.yaml` repeats only the reviewed overrides and roughjs patch;
   pnpm 12 ignores the older manifest configuration. Populate that
   store only from verified exact archives. Never regenerate/rescan a floating
   graph or accept an automatic package-manager download.
   The original offline preparation uses a separately approved, command-only
   `--trust-lockfile` for this exact independently audited lock. That skips a
   duplicate online metadata-policy check, not archive SRI, frozen-lock checks or
   the independent age/signature/advisory review. Do not persist it globally or
   reuse the exception for another graph. Generic pnpm 12 `--config` flags use
   kebab-case, including `--config.verify-store-integrity=true`,
   `--config.side-effects-cache=false` and `--config.package-import-method=copy`.
3. Run `node --import tsx build.mts` in the no-network filesystem-isolated build
   environment. The driver invokes the reviewed Langium generator explicitly,
   then one full-feature, minified classic-script IIFE build with upstream plugins.
4. Inspect `artifact/metafile.json` and source maps for actual embedded inputs;
   prove expected replacement versions and absence of superseded copies. The
   manifest inventory alone is not the compiled inventory.
5. Repeat from a second clean prepared context with the same verified graph.
   Compare SHA-256 of generated JavaScript, source maps and license output.
6. Run synthetic baseline/candidate diagram, math, failure and OC sandbox/SVG
   regressions. Keep original failures and diagnose before any correction.

The driver checks the unchanged OC 960 KiB gzip budget using Node level9/memLevel7.
Separately verify OC's exact canonical pako3.0.2 level9/legacyHash/memLevel7 output;
host zlib is not the authoritative packaged-sidecar identity.
Do not increase that budget, change compression settings to mask growth, remove
diagram families, or weaken runtime controls without separate approval.

## Build-Only Compatibility Adapter

The exact Langium CLI 4.2.1 schema has no root identifier and contains three
fragment-only references. Its pinned jsonschema 1.5.0 fails while resolving these
against its synthetic relative base. This is unrelated to fast-uri: that package
is consumed only by AJV, whose declared range accepts 3.1.8.

`generate-parser.mjs` pins the schema SHA-256, rejects non-fragment references or
existing identifiers, and temporarily supplies a fixed absolute local file URL
as `$id` to the in-memory schema. No dependency file or upstream source is edited.
The unmodified validator must accept the actual config and reject four malformed
configs; the actual Langium CLI must reject an invalid config before generating.
The non-ID schema is hash-checked and the temporary ID is removed in `finally`.
Both clean builds passed these checks and produced identical parser proof.

## Verified Output

Two clean prepared contexts produced byte-identical JavaScript, source map and
metafile. JavaScript SHA-256:
`8053618a9015411d8b50598605e7a1aa3a36b5880e085e5e2985fa2a4be621c0`.
The file is 3,480,883 bytes. Canonical OC pako3.0.2 gzip is 950,043 bytes
(927.776 KiB), below the unchanged 983,040-byte limit. No feature-family removal,
compression change or budget increase was used.

Compiled inputs prove DOMPurify3.4.16, KaTeX0.18.2, js-yaml4.3.2 and
lodash-es4.18.1; the superseded copies are absent from the generated source map.
The synthetic Chromium baseline/candidate proof passed all 32 cases, retaining
the exact official OC renderer/frame sources and fixed outer DOMPurify3.4.16.
Flowchart and mobile PNG pairs are byte-identical. This is bounded regression
coverage, not a complete upstream test suite or a claim of zero vulnerabilities.

## Integration Contract

The deliverable is generated `mermaid.min.js`, its license notices, SHA-256 receipt,
complete build lock, source identity and this recipe. Do not hand-edit minified
bytes or patch `node_modules`. Do not label the rebuilt bytes an official upstream
artifact or claim upstream attestation covers the modified output.

After review, the OpenClaw owner can add the generated asset and provenance files
under a renderer-owned vendor directory and change only the import target of the
existing `?url&no-inline` asset in `packages/mermaid-renderer/src/renderer.ts`.
Vite should hash/copy it using the same mechanism; `frame.js` continues to load a
classic `globalThis.mermaid` script. The final OC asset must hash to the reviewed
rebuilt bytes, and the packaged renderer must retain its license and recipe.
This describes a proposed integration, not a shared-source change made here.

The complete external OC pnpm graph remains owned by the lead. Updating its
DOMPurify/KaTeX resolution alone does not fix the opaque Mermaid asset. Conversely,
this asset does not replace OC's outer DOMPurify dependency. Preserve opaque-origin
`allow-scripts` iframe isolation, both CSPs, private MessageChannel, source/config
limits, config-root lock, final SVG allowlist, no external URLs, timeout and themes.
