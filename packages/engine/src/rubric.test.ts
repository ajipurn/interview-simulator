import type { LlmProvider } from "@selia/voice-core";
import { describe, expect, it } from "vitest";
import { generateRubric } from "./rubric.js";

const VALID = JSON.stringify({
  competencies: [
    {
      name: "Komunikasi",
      description: "Menyampaikan ide dengan jelas",
      weight: 2,
      rubricLevels: [1, 2, 3, 4, 5].map((level) => ({ level, descriptor: `level ${level}` })),
    },
    {
      name: "Orientasi Hasil",
      description: "Fokus pada dampak terukur",
      weight: 1,
      rubricLevels: [1, 2, 3, 4, 5].map((level) => ({ level, descriptor: `level ${level}` })),
    },
    {
      name: "Kerja Sama",
      description: "Berkolaborasi lintas peran",
      weight: 1,
      rubricLevels: [1, 2, 3, 4, 5].map((level) => ({ level, descriptor: `level ${level}` })),
    },
  ],
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

const INPUT = {
  jobTitle: "Customer Service",
  jdText: "Melayani pelanggan dan menangani komplain dengan baik.",
};

describe("generateRubric", () => {
  it("parses a valid rubric", async () => {
    const competencies = await generateRubric(scriptedLlm([`Berikut rubriknya:\n${VALID}`]), INPUT);
    expect(competencies).toHaveLength(3);
    expect(competencies[0]?.name).toBe("Komunikasi");
    expect(competencies.every((c) => c.rubricLevels.length === 5)).toBe(true);
  });

  it("retries schema failures until a valid reply", async () => {
    const competencies = await generateRubric(
      scriptedLlm(["bukan json", JSON.stringify({ competencies: [] }), VALID]),
      INPUT,
    );
    expect(competencies).toHaveLength(3);
  });

  it("throws after persistent garbage", async () => {
    await expect(generateRubric(scriptedLlm(["???"]), INPUT)).rejects.toThrow(
      /rubric generation failed/,
    );
  });
});
