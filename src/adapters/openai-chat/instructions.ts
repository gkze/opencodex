import { registryEntryForProviderDestination } from "../../providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../../types";
import { isObj as record } from "../../responses/parser-content";
import { stripBracketedModelSuffix } from "./wire";

function hasSingleLeadingSystemPolicy(provider: OcxProviderConfig, modelId: string): boolean {
  const wireModel = provider.modelSuffixBracketStrip ? stripBracketedModelSuffix(modelId) : modelId;
  return registryEntryForProviderDestination(provider)?.chatInstructionPolicy?.[wireModel] === "single-leading-system";
}

function instruction(value: unknown): value is Record<string, unknown> {
  return record(value) && (value.role === "system" || value.role === "developer");
}

function instructionText(message: Record<string, unknown>): string {
  // Combining messages cannot silently discard names, opaque parts or vendor metadata.
  if (Object.keys(message).some(key => key !== "role" && key !== "content")) {
    throw new Error("Unsupported instruction metadata for this model's single leading system message.");
  }
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content) && message.content.every(part =>
    record(part) && part.type === "text" && typeof part.text === "string"
    && Object.keys(part).every(key => key === "type" || key === "text"))) {
    return message.content.map(part => part.text).join("");
  }
  throw new Error("Unsupported instruction content for this model's single leading system message.");
}

/**
 * Apply a destination's declared template constraint at the final Chat boundary.
 * Only the uninterrupted initial instruction prefix can be consolidated. Hoisting
 * later instructions would change chronology and invalidate the reusable prefix.
 */
export function normalizeChatInstructions(
  messages: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  if (!hasSingleLeadingSystemPolicy(provider, modelId) || !Array.isArray(messages)) return messages;

  let prefixLength = 0;
  while (prefixLength < messages.length && instruction(messages[prefixLength])) prefixLength++;
  if (messages.slice(prefixLength).some(instruction)) {
    throw new Error("Unsupported mid-conversation system/developer instruction: this model requires a single leading system message. Choose a compatible model; instructions were not reordered.");
  }
  if (prefixLength === 0) return messages;
  const prefix = messages.slice(0, prefixLength).filter(instruction);
  const content = prefix.map(instructionText).join("\n\n");
  return [{ role: "system", content }, ...messages.slice(prefixLength)];
}

/** Validate before the Responses parser's system extraction and content projection can hide
 * unsupported instructions. Rebuild only the initial instruction prefix in source order;
 * all parsed conversation/tool items and request options retain their existing identities. */
export function prepareResponsesChatInstructions(parsed: OcxParsedRequest, provider: OcxProviderConfig): OcxParsedRequest {
  if (!hasSingleLeadingSystemPolicy(provider, parsed.modelId)) return parsed;
  const raw = parsed._rawBody;
  if (!record(raw) || !Array.isArray(raw.input)) return parsed;
  const input = raw.input.map(item => {
    if (!instruction(item)) return item;
    if ((item.type !== undefined && item.type !== "message")
      || Object.keys(item).some(key => !["role", "content", "type", "id", "status"].includes(key))) {
      throw new Error("Unsupported instruction metadata for this model's single leading system message.");
    }
    const content = Array.isArray(item.content) ? item.content.map(part =>
      record(part) && part.type === "input_text" ? { ...part, type: "text" } : part) : item.content;
    return { role: item.role, content };
  });
  normalizeChatInstructions(input, provider, parsed.modelId);
  const prefix = [];
  for (const item of input) {
    if (!instruction(item)) break;
    prefix.push(item);
  }
  if (!prefix.length) return parsed;
  const systemCount = prefix.filter(item => item.role === "system" && instructionText(item).length > 0).length;
  const developerCount = prefix.filter(item => item.role === "developer").length;
  const systemPrompt = parsed.context.systemPrompt ?? [];
  return { ...parsed, context: { ...parsed.context,
    systemPrompt: [...systemPrompt.slice(0, systemPrompt.length - systemCount), ...prefix.map(instructionText)],
    messages: parsed.context.messages.slice(developerCount),
  } };
}
