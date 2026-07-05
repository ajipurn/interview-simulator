/**
 * Minimal SSE reader shared by the LLM adapters (Anthropic, OpenAI, Gemini all
 * stream server-sent events). Yields the payload after `data: `, skipping
 * keep-alives and `[DONE]` sentinels. Handles chunks split mid-line.
 */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of body) {
    buf += decoder.decode(bytes, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      yield payload;
    }
  }
}
