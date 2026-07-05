import { describe, expect, it } from "vitest";
import { extractAnthropicDelta } from "./anthropic.js";
import { extractGeminiDelta } from "./gemini.js";
import { extractOpenAiDelta } from "./openai.js";
import { sseData } from "./sse.js";

function toBytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const c of chunks) yield encoder.encode(c);
  })();
}

describe("sseData", () => {
  it("yields payloads and skips [DONE] and keep-alives", async () => {
    const out: string[] = [];
    for await (const p of sseData(
      toBytes('data: {"a":1}\n\ndata: {"b":2}\n', "data: [DONE]\n\n"),
    )) {
      out.push(p);
    }
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles chunks split mid-line", async () => {
    const out: string[] = [];
    for await (const p of sseData(toBytes('data: {"tex', 't":"halo"}\n'))) out.push(p);
    expect(out).toEqual(['{"text":"halo"}']);
  });
});

describe("provider delta extraction", () => {
  it("anthropic", () => {
    expect(
      extractAnthropicDelta(
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Halo"}}',
      ),
    ).toBe("Halo");
    expect(extractAnthropicDelta('{"type":"message_start"}')).toBe("");
    expect(() => extractAnthropicDelta('{"type":"error","error":{"message":"boom"}}')).toThrow(
      /boom/,
    );
  });

  it("openai", () => {
    expect(extractOpenAiDelta('{"choices":[{"delta":{"content":"Halo"}}]}')).toBe("Halo");
    expect(extractOpenAiDelta('{"choices":[{"delta":{}}]}')).toBe("");
    expect(() => extractOpenAiDelta('{"error":{"message":"boom"}}')).toThrow(/boom/);
  });

  it("gemini", () => {
    expect(
      extractGeminiDelta('{"candidates":[{"content":{"parts":[{"text":"Ha"},{"text":"lo"}]}}]}'),
    ).toBe("Halo");
    expect(extractGeminiDelta('{"candidates":[{"content":{}}]}')).toBe("");
    expect(() => extractGeminiDelta('{"error":{"message":"boom"}}')).toThrow(/boom/);
  });
});
