import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, buildOpenAIChatPassthroughRequest } from "../../../src/adapters/openai-chat";
import { parseRequest } from "../../../src/responses/parser";
import { normalizeChatInstructions } from "../../../src/adapters/openai-chat/instructions";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/**
 * #5213. A `developer` message used to keep its slot only when the provider base URL host was
 * exactly `api.openai.com`. Everywhere else its text was appended to the system prompt and the
 * message itself was skipped, so an instruction written to apply from the second turn onward
 * arrived ahead of the first one. Both shapes return a normal completion, which is why these
 * assertions read the serialized request body rather than the response.
 */

const gateway: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.internal/v1",
  apiKey: "k",
};

describe("Cerebras Qwen leading instructions", () => {
  const modelId = "qwen-3.8-27b";
  const cerebras: OcxProviderConfig = { ...gateway, baseUrl: "https://api.cerebras.ai/v1" };
  const initial = [
    { role: "system", content: "Base instructions." },
    { role: "developer", content: [{ type: "text", text: "First rule." }, { type: "text", text: " Second rule." }] },
    { role: "user", content: "Review the synthetic project." },
  ];
  const expected = [
    { role: "system", content: "Base instructions.\n\nFirst rule. Second rule." },
    initial[2],
  ];

  test("native Chat consolidates the initial instruction prefix without mutating input", () => {
    const before = structuredClone(initial);
    const body = JSON.parse(buildOpenAIChatPassthroughRequest(cerebras, { messages: initial }, modelId, false).body);
    expect(body.messages).toEqual(expected);
    expect(initial).toEqual(before);
  });

  test("Responses instructions and initial Codex developer items share one system block", () => {
    const parsed = parseRequest({
      model: modelId,
      instructions: "Base instructions.",
      input: [
        { role: "developer", content: "First rule. Second rule." },
        { role: "user", content: "Review the synthetic project." },
      ],
      stream: true,
    });
    const body = JSON.parse(createOpenAIChatAdapter(cerebras).buildRequest({ ...parsed, modelId }).body);
    expect(body.messages).toEqual(expected);
    expect(body.stream).toBe(true);
  });

  test("tool calls, results and later user turns keep their positions and fields", () => {
    const tail = [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "found" },
      { role: "user", content: "Continue." },
    ];
    expect(normalizeChatInstructions([...initial, ...tail], cerebras, modelId)).toEqual([...expected, ...tail]);
  });

  test("appending a conversation turn does not change the serialized prefix", () => {
    const first = normalizeChatInstructions(initial, cerebras, modelId);
    expect(normalizeChatInstructions([...initial, { role: "user", content: "Next." }], cerebras, modelId))
      .toEqual([...(first as unknown[]), { role: "user", content: "Next." }]);
  });

  test("later instructions are refused rather than hoisted or downgraded", () => {
    for (const role of ["system", "developer"]) {
      expect(() => buildOpenAIChatPassthroughRequest(cerebras,
        { messages: [...initial, { role, content: "New rule." }] }, modelId, false))
        .toThrow("Unsupported mid-conversation");
      const parsed = parseRequest({ model: modelId, input: [
        { role: "user", content: "Earlier turn." }, { role, content: "Later rule." },
      ] });
      expect(() => createOpenAIChatAdapter(cerebras).buildRequest({ ...parsed, modelId }))
        .toThrow("Unsupported mid-conversation");
    }
  });

  test("unclassified providers and models retain their exact messages", () => {
    expect(normalizeChatInstructions(initial, gateway, modelId)).toBe(initial);
    expect(normalizeChatInstructions(initial, cerebras, "gpt-oss-120b")).toBe(initial);
    expect(normalizeChatInstructions(initial, { ...cerebras, baseUrl: "https://api.cerebras.ai.example/v1" }, modelId)).toBe(initial);
  });

  test("a renamed provider at the canonical destination gets the same template policy", () => {
    expect(normalizeChatInstructions(initial, { ...cerebras, baseUrl: "https://api.cerebras.ai/v1/" }, modelId)).toEqual(expected);
  });

  test("opaque instruction data is refused rather than discarded", () => {
    for (const message of [
      { role: "system", name: "special", content: "Keep metadata." },
      { role: "system", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] },
      { role: "developer", content: [{ type: "text", text: "Keep metadata.", cache_control: { type: "ephemeral" } }] },
    ]) expect(() => normalizeChatInstructions([message, initial[2]], cerebras, modelId)).toThrow("Unsupported instruction");
  });

  test("requests with no instructions remain unchanged", () => {
    const messages = [initial[2]];
    expect(normalizeChatInstructions(messages, cerebras, modelId)).toBe(messages);
  });

  test("Responses preserves mixed initial instruction order and leaves its parsed input untouched", () => {
    const parsed = parseRequest({ model: modelId, instructions: "Base.", input: [
      { role: "developer", content: [{ type: "input_text", text: "First." }] },
      { role: "system", content: "Second." },
      { role: "developer", content: "Third." },
      { role: "user", content: "Question." },
    ] });
    const before = structuredClone(parsed);
    const body = JSON.parse(createOpenAIChatAdapter(cerebras).buildRequest({ ...parsed, modelId }).body);
    expect(body.messages).toEqual([
      { role: "system", content: "Base.\n\nFirst.\n\nSecond.\n\nThird." },
      { role: "user", content: "Question." },
    ]);
    expect(parsed).toEqual(before);
  });

  test("Responses refuses opaque instructions before parsing can drop or demote them", () => {
    for (const role of ["system", "developer"]) {
      for (const content of [
        [{ type: "input_image", image_url: "https://example.test/image.png" }],
        [{ type: "input_text", text: "Rule.", cache_control: { type: "ephemeral" } }],
        [{ type: "unknown", data: "opaque" }],
      ]) {
        const parsed = parseRequest({ model: modelId, input: [{ type: "message", role, content }, initial[2]] });
        expect(() => createOpenAIChatAdapter(cerebras).buildRequest({ ...parsed, modelId })).toThrow("Unsupported instruction");
      }
    }
  });

  test("policy follows the final wire model when bracket stripping is enabled", () => {
    expect(normalizeChatInstructions(initial, { ...cerebras, modelSuffixBracketStrip: true }, `${modelId}[1m]`)).toEqual(expected);
    expect(normalizeChatInstructions(initial, cerebras, `${modelId}[1m]`)).toBe(initial);
  });

  test("Responses tool continuation retains calls, outputs, and cache controls", () => {
    const parsed = parseRequest({ model: modelId, instructions: "Base.", prompt_cache_key: "synthetic-session", stream: true, input: [
      { role: "developer", content: "Initial rule." },
      { role: "user", content: "Look up a number." },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "42" },
      { role: "user", content: "Continue." },
    ] });
    const body = JSON.parse(createOpenAIChatAdapter({ ...cerebras, promptCacheKey: true }).buildRequest({ ...parsed, modelId }).body);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(body.messages[2].tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }]);
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "42" });
    expect(body.prompt_cache_key).toBe("synthetic-session");
    expect(body.stream).toBe(true);
  });
});

function wireMessages(provider: OcxProviderConfig): Array<Record<string, unknown>> {
  const parsed = {
    modelId: "local-model",
    context: {
      systemPrompt: ["base instructions"],
      messages: [
        { role: "user", content: "First turn.", timestamp: 0 },
        { role: "developer", content: "Answer in exactly one sentence.", timestamp: 0 },
        { role: "user", content: "Second turn.", timestamp: 0 },
      ],
    },
    stream: false,
    options: {},
  } as unknown as OcxParsedRequest;
  const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
  return (JSON.parse(request.body) as { messages: Array<Record<string, unknown>> }).messages;
}

describe("developer message placement on the Chat wire", () => {
  test("a non-OpenAI gateway keeps the instruction between the two turns", () => {
    const messages = wireMessages(gateway);
    expect(messages[0]).toEqual({ role: "system", content: "base instructions" });
    expect(messages[1]).toEqual({ role: "user", content: "First turn." });
    expect(messages[2].content).toBe("Answer in exactly one sentence.");
    expect(messages[3]).toEqual({ role: "user", content: "Second turn." });
  });

  test("the leading system block no longer absorbs the instruction", () => {
    expect(String(wireMessages(gateway)[0].content)).not.toContain("Answer in exactly one sentence.");
  });

  test("placement does not depend on the destination host", () => {
    const hosts = [
      "https://openrouter.ai/api/v1",
      "http://localhost:1234/v1",
      "https://api.openai.com/v1",
    ];
    // Placement is asserted for both role states, because the role is decided separately and
    // must never be able to move the message.
    for (const baseUrl of hosts) {
      for (const declared of [{}, { foldDeveloperRoleToSystem: false }, { foldDeveloperRoleToSystem: true }]) {
        const messages = wireMessages({ ...gateway, baseUrl, ...declared });
        expect(messages).toHaveLength(4);
        expect(messages[2].content).toBe("Answer in exactly one sentence.");
        expect(messages[3]).toEqual({ role: "user", content: "Second turn." });
      }
    }
  });
});

describe("developer role on the Chat wire", () => {
  test("an undeclared destination folds the role rather than gambling on it", () => {
    // The reason this is the default: a gateway that rejects the role answers
    // `400 role 'developer' is not allowed` and the turn never starts. Forwarding by default
    // put that failure outside the repository, where no test could reach it.
    for (const baseUrl of ["https://openrouter.ai/api/v1", "http://localhost:1234/v1", "https://api.openai.com/v1"]) {
      expect(wireMessages({ ...gateway, baseUrl })[2]).toEqual({
        role: "system",
        content: "Answer in exactly one sentence.",
      });
    }
  });

  test("the role still never depends on the destination hostname", () => {
    const declared = { ...gateway, foldDeveloperRoleToSystem: false };
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
      expect(wireMessages({ ...declared, baseUrl })[2].role).toBe("developer");
    }
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
      expect(wireMessages({ ...gateway, baseUrl })[2].role).toBe("system");
    }
  });

  test("a destination that rejects the role converts it without moving the message", () => {
    const messages = wireMessages({ ...gateway, foldDeveloperRoleToSystem: true });
    expect(messages.map(message => message.role)).toEqual(["system", "user", "system", "user"]);
    expect(messages[2]).toEqual({ role: "system", content: "Answer in exactly one sentence." });
    expect(String(messages[0].content)).not.toContain("Answer in exactly one sentence.");
  });

  test("a destination known to accept the role forwards it in the same slot", () => {
    const messages = wireMessages({ ...gateway, foldDeveloperRoleToSystem: false });
    expect(messages.map(message => message.role)).toEqual(["system", "user", "developer", "user"]);
    expect(messages[2]).toEqual({ role: "developer", content: "Answer in exactly one sentence." });
  });
});
