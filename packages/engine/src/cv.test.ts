import type { LlmProvider } from "@selia/voice-core";
import { describe, expect, it } from "vitest";
import { parseCv } from "./cv.js";

const VALID = JSON.stringify({
  profile: {
    summary: "CS berpengalaman 2 tahun.",
    experiences: [{ company: "PT A", role: "CS", highlights: ["CSAT 4.6"] }],
    education: [{ institution: "Univ B" }],
    skills: ["komunikasi"],
    projects: [],
    probingPoints: ["klaim CSAT 4.6"],
  },
  confidence: 0.9,
});

function scriptedLlm(replies: string[]): LlmProvider {
  let i = 0;
  return {
    // biome-ignore lint/correctness/useYield: unused in these tests
    stream: async function* () {
      throw new Error("not used");
    },
    complete: async () => {
      const reply = replies[Math.min(i, replies.length - 1)] ?? "";
      i++;
      return reply;
    },
  };
}

describe("parseCv", () => {
  it("parses a valid profile", async () => {
    const out = await parseCv(scriptedLlm([VALID]), "CV teks mentah");
    expect(out.profile.experiences[0]?.company).toBe("PT A");
    expect(out.confidence).toBe(0.9);
  });

  it("retries until valid", async () => {
    const out = await parseCv(scriptedLlm(["bukan json", VALID]), "CV teks mentah");
    expect(out.profile.skills).toContain("komunikasi");
  });

  it("throws after persistent garbage", async () => {
    await expect(parseCv(scriptedLlm(["???"]), "CV")).rejects.toThrow(/cv parsing failed/);
  });
});
