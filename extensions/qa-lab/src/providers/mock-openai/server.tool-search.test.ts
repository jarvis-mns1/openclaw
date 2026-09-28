import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponses,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItem,
  outputText,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("mock Tool Search planning and summaries", () => {
  it("plans QA tool-search calls for instruction-declared Codex dynamic tools", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      instructions: "Codex dynamic OpenClaw tools available in this turn: web_search.",
      input: [
        makeUserInput(
          "tool search qa check target=web_search. Call exactly that tool once and then summarize.",
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_search");
    expect(String(toolPlanOutput.arguments)).toContain("OpenClaw runtime parity fixed query");
  });

  it("plans QA tool-search calls from explicit fixture targets even without Responses tools", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "tool search qa check target=session_status. Call exactly that tool once and then summarize.",
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("session_status");
    expect(String(toolPlanOutput.arguments)).toContain("current");
  });

  it("plans one structured scalar search for the Tool Search gateway fixture", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [{ type: "function", name: "tool_search" }],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("tool_search");
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      query: targetTool,
      limit: 1,
    });
  });

  it("prefers a directly declared target over structured catalog search", async () => {
    const server = await startMockServer();
    const targetTool = "web_fetch";

    const response = await expectNonStreamingResponses(server, {
      tools: [
        { type: "function", name: "tool_search" },
        { type: "function", name: targetTool },
      ],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
      ],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.name).toBe(targetTool);
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      url: "https://example.com/",
      maxChars: 500,
    });
  });

  it("plans separate batch discovery after the gateway fixture's scalar search", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";
    const response = await expectNonStreamingResponses(server, {
      tools: [
        { type: "function", name: "tool_search" },
        { type: "function", name: "tool_search_batch" },
        { type: "function", name: "tool_call" },
      ],
      input: [
        makeUserInput(`tool search qa check target=${targetTool} scalar-and-batch`),
        {
          type: "function_call",
          call_id: "call_tool_search_1",
          name: "tool_search",
          arguments: JSON.stringify({ query: targetTool, limit: 1 }),
        },
        makeToolOutputWithCallId("call_tool_search_1", JSON.stringify([{ name: targetTool }])),
      ],
    });
    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.name).toBe("tool_search_batch");
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      queries: [
        { query: targetTool, limit: 1 },
        { query: "fake plugin tool", limit: 2 },
      ],
    });
  });

  it.each(["tool_search", "tool_search_batch"])(
    "calls the selected catalog tool after %s",
    async (searchTool) => {
      const server = await startMockServer();
      const targetTool = "fake_plugin_tool_17";

      const response = await expectNonStreamingResponses(server, {
        tools: [
          { type: "function", name: searchTool },
          { type: "function", name: "tool_call" },
        ],
        input: [
          makeUserInput(
            `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
          ),
          {
            type: "function_call",
            call_id: "call_tool_search_1",
            name: searchTool,
            arguments: JSON.stringify(
              searchTool === "tool_search"
                ? { query: targetTool, limit: 1 }
                : { queries: [{ query: targetTool, limit: 1 }] },
            ),
          },
          makeToolOutputWithCallId(
            "call_tool_search_1",
            JSON.stringify(
              searchTool === "tool_search"
                ? [{ name: targetTool }]
                : { results: [{ query: targetTool, candidates: [{ name: targetTool }] }] },
            ),
          ),
        ],
      });

      const toolPlanOutput = outputItem(await response.json());
      expect(toolPlanOutput.type).toBe("function_call");
      expect(toolPlanOutput.name).toBe("tool_call");
      expect(JSON.parse(String(toolPlanOutput.arguments))).toMatchObject({ id: targetTool });
    },
  );

  it("does not call a catalog tool when structured search returns no matching candidate", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [
        { type: "function", name: "tool_search" },
        { type: "function", name: "tool_call" },
      ],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call",
          call_id: "call_tool_search_1",
          name: "tool_search",
          arguments: JSON.stringify({ query: targetTool, limit: 1 }),
        },
        makeToolOutputWithCallId("call_tool_search_1", JSON.stringify([])),
      ],
    });

    expect(outputItem(await response.json()).name).not.toBe("tool_call");
  });

  it("does not repeat a catalog call after its result mentions the target", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      tools: [{ type: "function", name: "tool_call" }],
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        {
          type: "function_call",
          call_id: "call_target_1",
          name: "tool_call",
          arguments: JSON.stringify({ id: targetTool, args: {} }),
        },
        makeToolOutputWithCallId("call_target_1", `failed to call ${targetTool}`),
      ],
    });

    expect(outputItem(await response.json()).name).not.toBe("tool_call");
  });

  it("plans the explicit web_fetch fixture prompt as the canonical direct call", async () => {
    const server = await startMockServer();
    const prompt =
      "Call web_fetch exactly once with URL https://example.com/ and maxChars 500, wait for its result, then summarize. If web_fetch is already callable, call it directly without tool_search. Otherwise use tool_search to locate it first, then call web_fetch. A tool_search result alone does not complete the task; do not finish before web_fetch returns. QA routing marker: tool search qa check target=web_fetch.";

    const response = await expectNonStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    const toolPlanOutput = outputItem(await response.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("web_fetch");
    expect(JSON.parse(String(toolPlanOutput.arguments))).toEqual({
      url: "https://example.com/",
      maxChars: 500,
    });
  });

  it("summarizes QA tool-search bridge outputs with the nested plugin result marker", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        makeToolOutputWithCallId(
          "call_tool_search_code_1",
          JSON.stringify({
            ok: true,
            value: {
              tool: {
                id: `openclaw:tool-search-e2e-fixture:${targetTool}`,
                source: "openclaw",
                sourceName: "tool-search-e2e-fixture",
                name: targetTool,
                description: "x".repeat(260),
              },
              result: {
                content: [
                  {
                    type: "text",
                    text: `FAKE_PLUGIN_OK ${targetTool} {"marker":"code"}`,
                  },
                ],
              },
            },
          }),
        ),
      ],
    });

    expect(outputText(await response.json())).toBe(`FAKE_PLUGIN_OK ${targetTool}`);
  });

  it("keeps QA tool-search result summaries ahead of generic worked/failed/blocked summaries", async () => {
    const server = await startMockServer();
    const targetTool = "fake_plugin_tool_17";

    const response = await expectNonStreamingResponses(server, {
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Answer in worked/failed/blocked format with source and docs notes.",
            },
          ],
        },
        makeUserInput(
          `tool search qa check target=${targetTool}. Call exactly that tool once and then summarize.`,
        ),
        makeToolOutputWithCallId(
          "call_tool_search_code_1",
          JSON.stringify({
            ok: true,
            value: {
              tool: { name: targetTool },
              result: {
                content: [{ type: "text", text: `FAKE_PLUGIN_OK ${targetTool}` }],
              },
            },
          }),
        ),
      ],
    });

    expect(outputText(await response.json())).toBe(`FAKE_PLUGIN_OK ${targetTool}`);
  });
});
