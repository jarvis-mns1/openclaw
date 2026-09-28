# Mermaid 11.17.2 Remediated Asset

This is an independently rebuilt, full-feature Mermaid 11.17.2 classic-script
asset, not an official upstream release or an upstream-attested rebuilt output.
The existing renderer imports `mermaid.min.js?url&no-inline`; Vite copies the
unchanged bytes to one deferred, content-addressed asset.

## Identity

- Upstream: https://github.com/mermaid-js/mermaid
- Source tag: `mermaid@11.17.2`.
- Exact source commit: `dcb694ddb58dc5ad3502e7e903cac05fd812eac3`.
- JavaScript: 3,480,883 bytes; SHA-256
  `8053618a9015411d8b50598605e7a1aa3a36b5880e085e5e2985fa2a4be621c0`.
- Retained compiled inputs include DOMPurify 3.4.16, KaTeX 0.18.2,
  js-yaml 4.3.2 and lodash-es 4.18.1.
- Canonical OC pako 3.0.2 gzip: 950,043 bytes, with level 9,
  legacyHash true and memLevel 7. The unchanged limit is 983,040 bytes.
- Original recipe archive SHA-256, retained for comparison with earlier receipts:
  `8b685ca220ea33543a8b251cb53f1fac9359d08be64194b50134d638b7eef0a7`.

`provenance.json` retains the exact source, graph, recipe, repeat-build and
bounded rendering-proof identities. `license-index.json` binds the full packaged
license texts in `THIRD_PARTY_NOTICES.txt`; Mermaid's own license is
`LICENSE-MERMAID`. Do not edit minified bytes, reformat receipt-bound payloads,
or patch installed dependencies.

## Receipts

`SHA256SUMS` verifies this source vendor directory, including `recipe-text/`.
`SHA256SUMS.original-unpacked` is the unchanged original 13-file deliverable
receipt. It describes the reconstructed recipe, before the `.txt` suffixes.

The eight files under `recipe-text/` contain the exact original bytes for these
paths, with `.txt` appended to each filename:

- `recipe/README.md`
- `recipe/build.mts`
- `recipe/generate-parser.mjs`
- `recipe/package.json`
- `recipe/patches/roughjs.patch`
- `recipe/pnpm-lock.yaml`
- `recipe/pnpm-workspace.yaml`
- `recipe/prepare.mjs`

The files are ordinary non-executable text, mode 0644. Their content hashes are
unchanged from the original recipe. Text storage exposes the complete recipe to
source review; the `.txt` suffix keeps its foreign TypeScript and manifests out
of OC's source/compiler graph. Restore the original names only in a separate
empty staging directory, never inside the OC checkout.

## Reconstruct and Rebuild

Start in this vendor directory. Verify the source receipt before reconstruction.
Copy only the verified files into a new empty temporary directory, never into
the OC checkout or an existing Mermaid checkout:

```sh
vendor="$(pwd)"
shasum -a 256 -c SHA256SUMS
staging="$(mktemp -d "${TMPDIR:-/tmp}/mermaid-recipe.XXXXXX")"
cp "$vendor/LICENSE-MERMAID" "$vendor/THIRD_PARTY_NOTICES.txt" \
  "$vendor/license-index.json" "$vendor/provenance.json" \
  "$vendor/mermaid.min.js" "$staging/"
cp "$vendor/SHA256SUMS.original-unpacked" "$staging/SHA256SUMS"
mkdir -p "$staging/recipe/patches"
for file in README.md build.mts generate-parser.mjs package.json \
  patches/roughjs.patch pnpm-lock.yaml pnpm-workspace.yaml prepare.mjs; do
  cp "$vendor/recipe-text/$file.txt" "$staging/recipe/$file"
done
(cd "$staging" && shasum -a 256 -c SHA256SUMS)
```

In a separate isolated Mermaid checkout, require HEAD to equal the exact source
commit above. After checking the unpacked receipt, copy `$staging/recipe/` to a
new `remediation/` directory in that checkout. Follow its `README.md`: verify
source blobs, prepare a new external build context, use only the independently
audited exact 205-pin graph with frozen/offline installation and hooks disabled,
then run the explicitly reviewed build driver in a secretless, no-network
environment. Reconstruction never installs dependencies or executes build hooks.

The reviewed in-memory schema-ID adapter belongs only to parser generation in
that separate build. It preserves native validation and negative controls and
does not modify dependency files or OC's runtime. The recipe records host Node
26.9.0 versus upstream's requested Node 24.16.0; it is not a cross-platform
reproducibility claim.

## Shipping

- The root npm allowlist ships `THIRD_PARTY_NOTICES.md`. Its Mermaid appendix
  carries the complete licenses and provenance without adding a new allowlist.
- The native build already copies `native/NOTICE.txt`, whose matching appendix
  carries the same licenses and provenance.
- This source directory retains the rebuild recipe and its original receipt;
  it is not an extra OC workspace package or a runtime dependency installation.
- The canonical OC build and final package inspection must confirm the exact
  JavaScript hash, one deferred `assets/mermaid.min-*.js`, unchanged gzip budget,
  and no stale engine reference. Those checks are separate from the isolated
  32-case Chromium proof recorded in the original provenance.

Keep `frame.js`, the opaque iframe, both CSPs, private channel, queues and limits,
configuration-root lock, and final SVG sanitizer unchanged.
