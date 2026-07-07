/**
 * Deterministic guardrail layer. Runs on EVERY AI utterance before TTS —
 * this is enforcement, not prompt-text hope. An optional LLM classifier can
 * be layered on top later; the blocklist is the floor.
 */

interface ProhibitedRule {
  topic: string;
  pattern: RegExp;
}

// Indonesian + English patterns for legally sensitive / discriminatory topics.
// Checked against AI utterances (questions), not candidate speech.
const PROHIBITED: ProhibitedRule[] = [
  {
    topic: "religion",
    pattern: /\b(agama|beragama|ibadah|salat|sholat|puasa|religion|religious|faith)\b/i,
  },
  {
    topic: "ethnicity",
    pattern: /\b(suku|etnis|ras\b|rasnya|keturunan|pribumi|ethnic|ethnicity|race)\b/i,
  },
  {
    topic: "marital_status",
    pattern:
      /\b(menikah|pernikahan|kawin|lajang|cerai|janda|duda|pasangan hidup|marital|married|divorce[d]?)\b/i,
  },
  {
    topic: "pregnancy_children",
    pattern:
      /\b(hamil|kehamilan|momongan|punya anak|rencana anak|program hamil|pregnan(t|cy)|childbearing)\b/i,
  },
  {
    topic: "age",
    pattern:
      /\b(usia|umur( kamu| anda)?|tanggal lahir|kelahiran tahun|how old|your age|date of birth)\b/i,
  },
  { topic: "sexual_orientation", pattern: /\b(orientasi seksual|sexual orientation|lgbt)\b/i },
  {
    topic: "health",
    pattern:
      /\b(penyakit|riwayat medis|kondisi medis|kesehatan mental|disabilitas|medical (history|condition)|disability|illness)\b/i,
  },
  {
    topic: "politics",
    pattern: /\b(partai|politik|pilpres|pemilu|political|politics|vote[d]?)\b/i,
  },
];

// Selia must never promise outcomes or leak decisions/scores.
const PROMISES: ProhibitedRule[] = [
  {
    topic: "outcome_promise",
    pattern:
      /\b(pasti (diterima|lolos|lanjut)|dijamin (diterima|lolos)|kamu (diterima|lolos|berhasil lolos)|akan (kami|di)terima|you('re| are) hired|you passed|guaranteed)\b/i,
  },
  {
    topic: "score_leak",
    pattern: /\b(skormu|skor kamu|nilai kamu|nilaimu|your score|kamu dapat nilai)\b/i,
  },
];

export type GuardrailResult =
  | { ok: true; text: string }
  | { ok: false; text: string; topic: string; original: string };

/**
 * Selia's register is "kamu"; LLM output drifts formal now and then despite
 * the persona prompt. Deterministic floor, same philosophy as the blocklist.
 * "kamu" is a grammatical drop-in wherever "Anda" appears.
 */
export function normalizeRegister(text: string): string {
  return text.replace(/\b[Aa]nda\b/g, "kamu");
}

// Every guarded utterance is mid-conversation (the scripted opener doesn't
// pass through here), so a leading greeting is always a model re-greeting the
// candidate — sounds like the interview restarted.
const LEADING_GREETING =
  /^\s*(?:(?:halo+|hai|hei|hey)|selamat\s+(?:pagi|siang|sore|malam|datang))[\s,!.…-]+/i;

/** Strip re-greetings from the front of an utterance ("Halo! Ceritakan…" → "Ceritakan…"). */
export function stripLeadingGreeting(text: string): string {
  let out = text;
  for (let i = 0; i < 3 && LEADING_GREETING.test(out); i++) {
    out = out.replace(LEADING_GREETING, "");
  }
  if (out === text) return text;
  if (!out.trim()) return text; // utterance was ONLY a greeting — empty is worse
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Check an AI utterance. If it trips a rule, return `ok: false` with a safe
 * replacement (`text` = the caller-provided fallback) so the interview keeps
 * flowing; the caller must log the event to the audit trail.
 */
export function checkUtterance(utterance: string, safeFallback: string): GuardrailResult {
  const normalized = stripLeadingGreeting(normalizeRegister(utterance));
  for (const rule of [...PROHIBITED, ...PROMISES]) {
    if (rule.pattern.test(normalized)) {
      return { ok: false, text: safeFallback, topic: rule.topic, original: utterance };
    }
  }
  return { ok: true, text: normalized };
}

/**
 * Instruction-shield untrusted input (CV text, candidate speech) before it is
 * interpolated into any prompt: strip characters that could break the data
 * fence, neutralize instruction-override phrasing, cap length.
 */
export function shield(text: string, maxLen = 4000): string {
  return text
    .replace(/[<>{}]/g, " ")
    .replace(
      /\b(abaikan|lupakan|ignore|forget|disregard)\b[^.\n]{0,60}\b(instruksi|perintah|aturan|instructions?|prompts?|rules?)\b/gi,
      "[disaring]",
    )
    .replace(/\b(system prompt|prompt sistem)\b/gi, "[disaring]")
    .slice(0, maxLen);
}
