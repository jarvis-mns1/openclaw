import { Minimatch } from "minimatch";

/** Pattern-only traversal hint; callers retain root admission and leaf matching. */
export function matchesMemoryGlobDirectory(relative: string, pattern: string): boolean {
  // Node 24 accepts foo/note.md for !(foo|@(bar|a))/**/*.md, but
  // minimatch 11 rejects foo as a prefix. Never prune runtime-accepted leaves.
  if (pattern.includes("!(")) {
    return true;
  }
  const matcher = new Minimatch(pattern, {
    nonegate: true,
    nocomment: true,
    windowsPathsNoEscape: true,
    platform: "linux",
    optimizationLevel: 0,
    nocase: process.platform === "darwin" || process.platform === "win32",
    nocaseMagicOnly: true,
    // Node and Bun differ on implicit dotfiles. Only the runtime leaf matcher
    // decides inclusion; allowing dot prefixes here cannot add indexed files.
    dot: true,
  });
  // Preserve conservative traversal for path-normalizing patterns: the runtime
  // leaf matcher, not this parser, owns their dot/parent-segment semantics.
  if (matcher.globParts.some((parts) => parts.some((part) => part === "." || part === ".."))) {
    return true;
  }
  return matcher.match(relative, true);
}
