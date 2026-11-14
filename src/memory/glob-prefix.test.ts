import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesMemoryGlobDirectory } from "./glob-prefix.js";

describe("matchesMemoryGlobDirectory", () => {
  it.each([
    {
      pattern: "{*.md,controls/*.md,observability/runbooks/*.md}",
      keep: ["controls", "observability", "observability/runbooks"],
      prune: ["cache", "cache/deep", "controls/deep", "observability/metrics"],
    },
    {
      pattern: "@(controls|observability)/+(runbooks|guides)/*.md",
      keep: ["controls", "observability", "observability/runbooks", "controls/guides"],
      prune: ["cache", "controls/cache", "observability/runbooks/deep"],
    },
    {
      pattern: "[co]*/[rg]*/*.md",
      keep: ["controls", "observability", "controls/guides", "observability/runbooks"],
      prune: ["archive", "controls/cache", "observability/runbooks/deep"],
    },
    {
      pattern: "{controls,controls/runbooks}/*.md",
      keep: ["controls", "controls/runbooks"],
      prune: ["cache", "controls/cache"],
    },
    {
      pattern: "controls/**/*.md",
      keep: ["controls", "controls/deep", "controls/archive.md", "controls/archive.md/deep"],
      prune: ["cache", "cache/deep"],
    },
    {
      pattern: "#notes/**",
      keep: ["#notes", "#notes/deep"],
      prune: ["notes", "cache"],
    },
    {
      pattern: ".notes/**/*.md",
      keep: [".notes", ".notes/deep"],
      prune: ["notes", ".cache"],
    },
  ])("uses parser partial matching for $pattern", ({ pattern, keep, prune }) => {
    for (const directory of keep) {
      expect(matchesMemoryGlobDirectory(directory, pattern), directory).toBe(true);
    }
    for (const directory of prune) {
      expect(matchesMemoryGlobDirectory(directory, pattern), directory).toBe(false);
    }
  });

  it.each(["!(cache)/**/*.md", "!(foo|@(bar|a))/**/*.md", "notes/../controls/*.md"])(
    "keeps incompatible syntax conservative: %s",
    (pattern) => {
      expect(matchesMemoryGlobDirectory("foo", pattern)).toBe(true);
    },
  );

  it("never prunes ancestors of runtime-matched leaves", () => {
    const directories = ["controls", "CONTROLS", ".notes", "foo", "cache", "é", "#notes"];
    const patterns = [
      "**/*.md",
      "{controls,.notes}/**/*.md",
      "@(.notes|controls)/**/*.md",
      "[[:alpha:]]*/**/*.md",
      "!(foo|@(bar|a))/**/*.md",
      "#notes/**/*.md",
    ];
    for (const pattern of patterns) {
      for (const directory of directories) {
        for (const leaf of ["note.md", "deep/note.md", ".hidden/note.md"]) {
          const file = `${directory}/${leaf}`;
          if (!path.posix.matchesGlob(file, pattern)) {
            continue;
          }
          for (let ancestor = path.posix.dirname(file); ancestor !== ".";) {
            expect(matchesMemoryGlobDirectory(ancestor, pattern), `${pattern}: ${file}`).toBe(true);
            ancestor = path.posix.dirname(ancestor);
          }
        }
      }
    }
  });
});
