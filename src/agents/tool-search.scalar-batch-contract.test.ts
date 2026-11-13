import { validateToolArguments } from "@openclaw/ai/validation";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

function searchFixture(modelProvider?: string) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({
    catalogRef,
    tools: [
      {
        name: "calendar_lookup",
        label: "Calendar",
        description: "Look up calendar events",
        parameters: Type.Object({}),
        execute: async () => jsonResult({}),
      },
    ],
  });
  const tools = finalizeAgentTools({
    tools: createToolSearchTools({ catalogRef }),
    modelProvider,
    hookContext: {},
    wrapBeforeToolCallHook: false,
  });
  const tool = (name: string) =>
    expectDefined(
      tools.find((entry) => entry.name === name),
      name,
    );
  const execute = async (name: string, input: Record<string, unknown>) => {
    const target = tool(name);
    return target.execute(
      "search-contract",
      validateToolArguments(target, {
        type: "toolCall",
        id: "search-contract",
        name,
        arguments: input,
      }),
    );
  };
  return { catalogRef, tools, tool, execute };
}

const queries = (count: number) =>
  Array.from({ length: count }, () => ({ query: "calendar_lookup", limit: 1 }));

describe("separate scalar and batch Tool Search contracts", () => {
  it("advertises closed, non-overloaded schemas and retains the 11.3 dispatcher", () => {
    const tools = createToolSearchTools({});
    expect(tools.map((tool) => tool.name)).toEqual([
      "tool_search",
      "tool_describe",
      "dispatch_action",
      "tool_search_batch",
    ]);
    const scalar = expectDefined(
      tools.find((tool) => tool.name === "tool_search"),
      "scalar",
    );
    const batch = expectDefined(
      tools.find((tool) => tool.name === "tool_search_batch"),
      "batch",
    );
    expect(scalar.parameters).toMatchObject({ additionalProperties: false, required: ["query"] });
    expect(batch.parameters).toMatchObject({ additionalProperties: false, required: ["queries"] });
    expect(scalar.parameters).not.toHaveProperty("properties.queries");
    expect(batch.parameters).not.toHaveProperty("properties.query");
    for (const input of [{}, { query: "calendar", queries: queries(1) }]) {
      expect(Value.Check(scalar.parameters, input)).toBe(false);
      expect(Value.Check(batch.parameters, input)).toBe(false);
    }
    expect(Value.Check(scalar.parameters, { query: "calendar", limit: null })).toBe(false);
    expect(Value.Check(batch.parameters, { queries: queries(0) })).toBe(false);
    expect(Value.Check(batch.parameters, { queries: queries(17) })).toBe(false);
    expect(
      Value.Check(batch.parameters, { queries: [{ query: "calendar", options: { limit: 1 } }] }),
    ).toBe(false);
  });

  it.each([undefined, "openai", "anthropic", "google"])(
    "executes independent scalar and batch calls after %s projection",
    async (provider) => {
      const { execute, catalogRef } = searchFixture(provider);
      await expect(
        execute("tool_search", { query: "calendar_lookup", limit: 1 }),
      ).resolves.toMatchObject({
        details: [expect.objectContaining({ name: "calendar_lookup" })],
      });
      await expect(execute("tool_search", { query: "  " })).resolves.toMatchObject({ details: [] });
      for (const count of [1, 16]) {
        const result = await execute("tool_search_batch", { queries: queries(count) });
        expect(result.details).toMatchObject({
          results: Array.from({ length: count }, () => ({
            query: "calendar_lookup",
            candidates: expect.any(Array),
          })),
        });
      }
      expect(catalogRef.current?.searchCount).toBe(19);
    },
  );

  it.each([
    {
      name: "tool_search",
      input: { query: "calendar", queries: queries(1) },
      error: "Use tool_search_batch",
    },
    {
      name: "tool_search",
      input: { query: "calendar", queries: false },
      error: "Use tool_search_batch",
    },
    {
      name: "tool_search",
      input: { query: "calendar", options: { limit: 1 } },
      error: "set limit directly",
    },
    {
      name: "tool_search_batch",
      input: { query: "calendar", queries: queries(1) },
      error: "Put every search in queries",
    },
    {
      name: "tool_search_batch",
      input: { queries: queries(1), limit: 1 },
      error: "set limit on each batch query",
    },
    {
      name: "tool_search_batch",
      input: { queries: queries(1), options: false },
      error: "set limit on each batch query",
    },
    {
      name: "tool_search_batch",
      input: { queries: [...queries(1), { query: "calendar", options: { limit: 1 } }] },
      error: "set queries[1].limit directly",
    },
    { name: "tool_search_batch", input: { queries: queries(0) }, error: "non-empty array" },
    { name: "tool_search_batch", input: { queries: queries(17) }, error: "at most 16 entries" },
    {
      name: "tool_search_batch",
      input: { queries: [{ query: "x".repeat(513), limit: 1 }] },
      error: "must not exceed 512 characters",
    },
  ])(
    "rejects projected malformed $name input before any search: $error",
    async ({ name, input, error }) => {
      const { execute, catalogRef, tool } = searchFixture("google");
      // Gemini removes closure/cardinality constraints; the runtime still owns admission.
      expect(Value.Check(tool(name).parameters, input)).toBe(true);
      await expect(execute(name, input)).rejects.toThrow(error);
      expect(catalogRef.current?.searchCount).toBe(0);
    },
  );

  it.each([undefined, "openai", "anthropic", "google"])(
    "validates complete semantic batch budgets before searching after %s projection",
    async (provider) => {
      const { execute, catalogRef } = searchFixture(provider);
      for (const [batch, error] of [
        [[...queries(1), { query: "  " }], "queries[1].query must be a non-empty string"],
        [Array.from({ length: 7 }, () => ({ query: "calendar" })), "resolve to 56 results"],
        [[20, 20, 11].map((limit) => ({ query: "calendar", limit })), "resolve to 51 results"],
        [[{ query: "\u00e9".repeat(255), limit: 1 }], "at most 512 UTF-8 bytes"],
        [[{ query: '"'.repeat(255), limit: 1 }], "at most 512 UTF-8 bytes"],
      ] as const) {
        await expect(execute("tool_search_batch", { queries: batch })).rejects.toThrow(error);
        expect(catalogRef.current?.searchCount).toBe(0);
      }
      const query = "\u00e9".repeat(254);
      await expect(
        execute("tool_search_batch", { queries: [{ query, limit: 1 }] }),
      ).resolves.toMatchObject({
        details: { results: [{ query, candidates: [] }] },
      });
      const result = await execute("tool_search_batch", {
        queries: [20, 20, 10].map((limit) => ({ query: "calendar_lookup", limit })),
      });
      expect(result.details).toMatchObject({
        results: Array.from({ length: 3 }, () => ({
          query: "calendar_lookup",
          candidates: [expect.objectContaining({ name: "calendar_lookup" })],
        })),
      });
      expect(catalogRef.current?.searchCount).toBe(4);
    },
  );

  it("tolerates only empty legacy placeholders after provider projection", async () => {
    const { execute, catalogRef } = searchFixture("google");
    for (const placeholder of [null, []]) {
      await expect(
        execute("tool_search", { query: "calendar_lookup", queries: placeholder, options: {} }),
      ).resolves.toMatchObject({
        details: [expect.objectContaining({ name: "calendar_lookup" })],
      });
    }
    for (const placeholder of [null, "", "  "]) {
      await expect(
        execute("tool_search_batch", {
          query: placeholder,
          limit: null,
          options: {},
          queries: [{ query: "calendar_lookup", options: {} }],
        }),
      ).resolves.toMatchObject({ details: { results: [{ query: "calendar_lookup" }] } });
    }
    expect(catalogRef.current?.searchCount).toBe(5);
  });
});
