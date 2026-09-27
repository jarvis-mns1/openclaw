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
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fixture(modelProvider?: string) {
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
  const tools = createToolSearchTools({ catalogRef });
  const projected = modelProvider
    ? finalizeAgentTools({
        tools,
        modelProvider,
        hookContext: {},
        wrapBeforeToolCallHook: false,
      })
    : tools;
  const scalar = expectDefined(
    projected.find((tool) => tool.name === "tool_search"),
    "scalar search control",
  );
  const batch = expectDefined(
    projected.find((tool) => tool.name === "tool_search_batch"),
    "batch search control",
  );
  const execute = (tool: AnyAgentTool, input: Record<string, unknown>) => {
    const validatedArguments = validateToolArguments(tool, {
      type: "toolCall",
      id: "search-contract",
      name: tool.name,
      arguments: input,
    });
    return tool.execute("search-contract", validatedArguments);
  };
  return { catalogRef, scalar, batch, execute };
}

const queries = (count: number) =>
  Array.from({ length: count }, () => ({ query: "calendar_lookup", limit: 1 }));

describe("scalar and batch Tool Search admission", () => {
  it("requires separate closed scalar and batch shapes", () => {
    const { scalar, batch } = fixture();
    expect(scalar.parameters).toMatchObject({ additionalProperties: false, required: ["query"] });
    expect(batch.parameters).toMatchObject({
      additionalProperties: false,
      required: ["queries"],
      properties: { queries: { minItems: 1, maxItems: 16 } },
    });
    for (const input of [{}, { queries: queries(1) }, { query: "calendar", queries: queries(1) }]) {
      expect(Value.Check(scalar.parameters, input)).toBe(false);
    }
    for (const input of [{}, { query: "calendar" }, { query: "calendar", queries: queries(1) }]) {
      expect(Value.Check(batch.parameters, input)).toBe(false);
    }
  });

  it.each([0, 17])("rejects %i queries in the canonical schema before execution", (count) => {
    const { batch, execute, catalogRef } = fixture();
    const input = { queries: queries(count) };
    expect(Value.Check(batch.parameters, input)).toBe(false);
    expect(() => execute(batch, input)).toThrow("Validation failed");
    expect(catalogRef.current?.searchCount).toBe(0);
  });

  it.each([0, 17])(
    "keeps the runtime bound after Gemini strips schema cardinality: %i",
    async (count) => {
      const { batch, execute, catalogRef } = fixture("google");
      const input = { queries: queries(count) };
      expect(batch.parameters).not.toHaveProperty("properties.queries.minItems");
      expect(batch.parameters).not.toHaveProperty("properties.queries.maxItems");
      expect(Value.Check(batch.parameters, input)).toBe(true);
      await expect(execute(batch, input)).rejects.toThrow(
        count === 0
          ? "queries must be a non-empty array"
          : "queries may contain at most 16 entries",
      );
      expect(catalogRef.current?.searchCount).toBe(0);
    },
  );

  it.each([
    { label: "empty", query: "", error: "queries[0].query must be a non-empty string" },
    {
      label: "overlong",
      query: "q".repeat(513),
      error: "queries[0].query must not exceed 512 characters",
    },
  ])(
    "enforces $label query bounds before and after provider projection",
    async ({ query, error }) => {
      const raw = fixture();
      const projected = fixture("google");
      const input = { queries: [{ query, limit: 1 }] };
      expect(Value.Check(raw.batch.parameters, input)).toBe(false);
      expect(() => raw.execute(raw.batch, input)).toThrow("Validation failed");
      expect(Value.Check(projected.batch.parameters, input)).toBe(true);
      await expect(projected.execute(projected.batch, input)).rejects.toThrow(error);
      expect(raw.catalogRef.current?.searchCount).toBe(0);
      expect(projected.catalogRef.current?.searchCount).toBe(0);
    },
  );

  it.each([
    { tool: "scalar", wrong: queries(1) },
    { tool: "scalar", wrong: {} },
    { tool: "scalar", wrong: false },
    { tool: "scalar", wrong: 1 },
    { tool: "scalar", wrong: "calendar" },
    { tool: "scalar", wrong: "" },
    { tool: "batch", wrong: "calendar" },
    { tool: "batch", wrong: {} },
    { tool: "batch", wrong: false },
    { tool: "batch", wrong: 1 },
    { tool: "batch", wrong: [] },
  ])("rejects $tool wrong-field input after projection: $wrong", async ({ tool, wrong }) => {
    const raw = fixture();
    const projected = fixture("google");
    const scalar = tool === "scalar";
    const input = scalar
      ? { query: "calendar_lookup", queries: wrong }
      : { queries: queries(1), query: wrong };
    const rawTool = scalar ? raw.scalar : raw.batch;
    const projectedTool = scalar ? projected.scalar : projected.batch;
    expect(Value.Check(rawTool.parameters, input)).toBe(false);
    expect(() => raw.execute(rawTool, input)).toThrow("Validation failed");
    expect(Value.Check(projectedTool.parameters, input)).toBe(true);
    await expect(projected.execute(projectedTool, input)).rejects.toThrow(
      scalar ? "Use tool_search_batch with queries" : "Put every search in queries",
    );
    expect(raw.catalogRef.current?.searchCount).toBe(0);
    expect(projected.catalogRef.current?.searchCount).toBe(0);
  });

  it.each([
    { tool: "scalar", placeholder: null },
    { tool: "scalar", placeholder: [] },
    { tool: "batch", placeholder: null },
    { tool: "batch", placeholder: "" },
    { tool: "batch", placeholder: "   " },
  ])(
    "accepts $tool legacy placeholder after projection: $placeholder",
    async ({ tool, placeholder }) => {
      const { scalar, batch, execute, catalogRef } = fixture("google");
      const scalarCall = tool === "scalar";
      const input = scalarCall
        ? { query: "calendar_lookup", queries: placeholder }
        : { queries: queries(1), query: placeholder };
      const result = await execute(scalarCall ? scalar : batch, input);
      expect(result.details).toEqual(
        scalarCall
          ? [expect.objectContaining({ name: "calendar_lookup" })]
          : {
              results: [
                {
                  query: "calendar_lookup",
                  candidates: [expect.objectContaining({ name: "calendar_lookup" })],
                },
              ],
            },
      );
      expect(catalogRef.current?.searchCount).toBe(1);
    },
  );

  it.each([
    { options: { limit: 1 } },
    { options: { limit: "invalid" } },
    { options: { other: true } },
    { options: false },
    { options: [] },
    { options: 0 },
    { options: "" },
  ])("rejects scalar options before search after projection: %j", async ({ options }) => {
    const raw = fixture();
    const projected = fixture("google");
    const input = { query: "calendar_lookup", options };
    expect(Value.Check(raw.scalar.parameters, input)).toBe(false);
    expect(() => raw.execute(raw.scalar, input)).toThrow("Validation failed");
    expect(Value.Check(projected.scalar.parameters, input)).toBe(true);
    await expect(projected.execute(projected.scalar, input)).rejects.toThrow(
      "set limit directly on tool_search, not inside options",
    );
    expect(raw.catalogRef.current?.searchCount).toBe(0);
    expect(projected.catalogRef.current?.searchCount).toBe(0);
  });

  it.each([null, {}])("tolerates empty scalar options after projection: %j", async (options) => {
    const { scalar, execute, catalogRef } = fixture("google");
    await expect(
      execute(scalar, { query: "calendar_lookup", limit: 1, options }),
    ).resolves.toMatchObject({ details: [expect.objectContaining({ name: "calendar_lookup" })] });
    expect(catalogRef.current?.searchCount).toBe(1);
  });

  it.each([
    { limit: 1 },
    { limit: 0 },
    { limit: false },
    { limit: "" },
    { options: { limit: 1 } },
    { options: false },
    { options: [] },
  ])("rejects meaningful batch-level options after projection: %j", async (extra) => {
    const { batch, execute, catalogRef } = fixture("google");
    const input = { queries: queries(1), ...extra };
    expect(Value.Check(batch.parameters, input)).toBe(true);
    await expect(execute(batch, input)).rejects.toThrow("set limit on each batch query");
    expect(catalogRef.current?.searchCount).toBe(0);
  });

  it.each([{ limit: null, options: null }, { options: {} }])(
    "tolerates empty batch-level placeholders after projection: %j",
    async (extra) => {
      const { batch, execute, catalogRef } = fixture("google");
      await expect(execute(batch, { queries: queries(1), ...extra })).resolves.toMatchObject({
        details: { results: [{ query: "calendar_lookup" }] },
      });
      expect(catalogRef.current?.searchCount).toBe(1);
    },
  );

  it.each([
    { options: { limit: 1 } },
    { options: { limit: "invalid" } },
    { options: { other: true } },
    { options: false },
    { options: [] },
    { options: 0 },
    { options: "" },
  ])("rejects batch-entry options before any search after projection: %j", async ({ options }) => {
    const raw = fixture();
    const projected = fixture("google");
    const input = { queries: [...queries(1), { query: "calendar_lookup", options }] };
    expect(Value.Check(raw.batch.parameters, input)).toBe(false);
    expect(() => raw.execute(raw.batch, input)).toThrow("Validation failed");
    expect(Value.Check(projected.batch.parameters, input)).toBe(true);
    await expect(projected.execute(projected.batch, input)).rejects.toThrow(
      "set queries[1].limit directly, not inside options",
    );
    expect(raw.catalogRef.current?.searchCount).toBe(0);
    expect(projected.catalogRef.current?.searchCount).toBe(0);
  });

  it.each([null, {}])(
    "tolerates empty batch-entry options after projection: %j",
    async (options) => {
      const { batch, execute, catalogRef } = fixture("google");
      await expect(
        execute(batch, { queries: [{ query: "calendar_lookup", limit: 1, options }] }),
      ).resolves.toMatchObject({ details: { results: [{ query: "calendar_lookup" }] } });
      expect(catalogRef.current?.searchCount).toBe(1);
    },
  );

  it.each([undefined, "openai", "anthropic", "google"])(
    "enforces semantic batch budgets before any search after %s projection",
    async (provider) => {
      const cases = [
        {
          input: { queries: [{ query: "calendar_lookup", limit: 1 }, { query: "  " }] },
          error: "queries[1].query must be a non-empty string",
        },
        {
          input: { queries: Array.from({ length: 7 }, () => ({ query: "calendar_lookup" })) },
          error: "resolve to 56 results",
        },
        {
          input: {
            queries: Array.from({ length: 3 }, () => ({ query: "calendar_lookup", limit: 20 })),
          },
          error: "resolve to 60 results",
        },
        {
          input: {
            queries: [
              { query: "calendar_lookup", limit: 1 },
              { query: "\u00e9".repeat(254), limit: 1 },
            ],
          },
          error: "at most 512 UTF-8 bytes",
        },
        {
          input: { queries: [{ query: "\ud83d\ude00".repeat(128), limit: 1 }] },
          error: "at most 512 UTF-8 bytes",
        },
        {
          input: { queries: [{ query: '"'.repeat(255), limit: 1 }] },
          error: "at most 512 UTF-8 bytes",
        },
      ];
      for (const { input, error } of cases) {
        const { batch, execute, catalogRef } = fixture(provider);
        expect(Value.Check(batch.parameters, input)).toBe(true);
        await expect(execute(batch, input)).rejects.toThrow(error);
        expect(catalogRef.current?.searchCount).toBe(0);
      }
    },
  );

  it.each([undefined, "openai", "anthropic", "google"])(
    "accepts exact UTF-8 and result budgets without collapsing duplicates after %s projection",
    async (provider) => {
      const { batch, execute, catalogRef } = fixture(provider);
      const query = "\u00e9".repeat(254);
      expect(new TextEncoder().encode(JSON.stringify([query])).byteLength).toBe(512);
      await expect(execute(batch, { queries: [{ query, limit: 1 }] })).resolves.toMatchObject({
        details: { results: [{ query, candidates: [] }] },
      });
      const result = await execute(batch, {
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

  it.each([undefined, "openai", "anthropic", "google"])(
    "executes scalar and 1/16-query batches after %s projection",
    async (provider) => {
      const { scalar, batch, execute, catalogRef } = fixture(provider);
      const scalarResult = await execute(scalar, { query: "calendar_lookup", limit: 1 });
      expect(scalarResult.details).toEqual([expect.objectContaining({ name: "calendar_lookup" })]);
      for (const count of [1, 16]) {
        const result = await execute(batch, { queries: queries(count) });
        expect(result.details).toMatchObject({
          results: Array.from({ length: count }, () => ({
            query: "calendar_lookup",
            candidates: expect.any(Array),
          })),
        });
      }
      expect(catalogRef.current?.searchCount).toBe(18);
    },
  );
});
