import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FAKE_PLUGIN_ID = "tool-search-e2e-fixture";

export function buildFakeTools(count = 36) {
  return Array.from({ length: count }, (_, index) => {
    const id = `fake_plugin_tool_${String(index + 1).padStart(2, "0")}`;
    return {
      type: "function",
      name: id,
      description: [
        `Fake plugin tool ${index + 1}.`,
        "Used by the Tool Search gateway E2E to prove a large plugin-owned tool catalog can be hidden from the model prompt and still called through the compact bridge.",
        "The description is intentionally non-trivial so prompt-size regression is measurable.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          marker: {
            type: "string",
            description: "Lane marker supplied by the scripted model.",
          },
        },
        required: ["marker"],
        additionalProperties: false,
      },
      strict: true,
    };
  });
}

export async function writeFakePlugin(params: {
  rootDir: string;
  repoRoot: string;
  fakeTools: ReturnType<typeof buildFakeTools>;
}): Promise<string> {
  const pluginDir = path.join(params.rootDir, "tool-search-fake-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/tool-search-e2e-fixture",
        version: "0.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: FAKE_PLUGIN_ID,
        activation: {
          onStartup: true,
        },
        name: "Tool Search E2E Fixture",
        description: "Fake plugin with a large tool catalog for Tool Search gateway validation.",
        contracts: {
          tools: params.fakeTools.map((tool) => tool.name),
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const pluginEntryUrl = pathToFileURL(
    path.join(params.repoRoot, "dist/plugin-sdk/plugin-entry.js"),
  ).href;
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      `import { definePluginEntry } from ${JSON.stringify(pluginEntryUrl)};`,
      `const tools = ${JSON.stringify(params.fakeTools, null, 2)};`,
      "export default definePluginEntry({",
      `  id: ${JSON.stringify(FAKE_PLUGIN_ID)},`,
      "  name: 'Tool Search E2E Fixture',",
      "  register(api) {",
      "    for (const spec of tools) {",
      '      api["registerTool"]({',
      "        name: spec.name,",
      "        label: spec.name,",
      "        description: spec.description,",
      "        parameters: spec.parameters,",
      "        execute: async (_toolCallId, input) => ({",
      "          content: [{ type: 'text', text: `FAKE_PLUGIN_OK ${spec.name} ${JSON.stringify(input ?? {})}` }],",
      "          details: { status: 'ok', tool: spec.name, input },",
      "        }),",
      "      }, { name: spec.name });",
      "    }",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return pluginDir;
}
