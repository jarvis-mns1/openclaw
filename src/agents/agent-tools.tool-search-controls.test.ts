import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawCodingTools Tool Search controls", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("does not add Tool Search control tools from the shared factory by default", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(false);
    expect(names.has("tool_search")).toBe(false);
    expect(names.has("tool_search_batch")).toBe(false);
    expect(names.has("tool_describe")).toBe(false);
    expect(names.has("tool_call")).toBe(false);
  });

  it("adds Tool Search control tools when explicitly requested", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_search_batch")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
  });

  it("keeps Tool Search controls available under restrictive tool profiles", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          profile: "coding",
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_search_batch")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
    expect(names.has("message")).toBe(false);
  });

  it("keeps Tool Search controls available under restrictive tool allowlists", () => {
    const tools = createOpenClawCodingTools({
      includeToolSearchControls: true,
      config: {
        tools: {
          allow: ["read"],
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_search_batch")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
  });

  it.each(["tool_search_code", "tool_search_batch"])(
    "lets explicit deny policies remove %s",
    (name) => {
      const tools = createOpenClawCodingTools({
        includeToolSearchControls: true,
        config: {
          tools: {
            profile: "coding",
            deny: [name],
            toolSearch: true,
          },
        },
      });
      const names = new Set(tools.map((tool) => tool.name));

      expect(names.has(name)).toBe(false);
      expect(names.has("read")).toBe(true);
    },
  );

  it("keeps Tool Search controls when core OpenClaw tools are not materialized", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    const tools = createOpenClawCodingTools({
      includeCoreTools: false,
      includeToolSearchControls: true,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: true,
      },
      config: {
        tools: {
          toolSearch: true,
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));

    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expect(names.has("tool_search_code")).toBe(true);
    expect(names.has("tool_search")).toBe(true);
    expect(names.has("tool_search_batch")).toBe(true);
    expect(names.has("tool_describe")).toBe(true);
    expect(names.has("tool_call")).toBe(true);
    expect(names.has("message")).toBe(false);
    expect(names.has("exec")).toBe(false);
  });
});
