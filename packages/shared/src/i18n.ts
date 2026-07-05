/**
 * Candidate-facing copy — warm, informal-professional Bahasa Indonesia ("kamu" register).
 * All candidate UI strings live here; do not hardcode copy in apps.
 */
export const id = {
  consent: {
    title: "Sebelum kita mulai",
    aiDisclosure:
      "Kamu akan diwawancarai oleh Selia, pewawancara AI. Ini bukan manusia — tapi Selia akan mendengarkan jawabanmu dengan saksama.",
    dataProcessing:
      "Dengan melanjutkan, kamu setuju bahwa wawancara ini direkam (video & audio) dan jawabanmu diproses untuk penilaian oleh perusahaan yang membuka lowongan ini.",
    rights:
      "Kamu berhak meminta penghapusan datamu kapan saja. Penilaian hanya berdasarkan isi jawabanmu — bukan wajah, aksen, atau penampilan.",
    checkbox: "Saya mengerti dan setuju",
    start: "Mulai wawancara",
    privacyLink: "Kebijakan privasi",
  },
  deviceCheck: {
    title: "Cek kamera & mikrofon",
    cameraPrompt:
      "Izinkan akses kamera dan mikrofon ya, supaya Selia bisa melihat dan mendengarmu.",
    networkTesting: "Mengecek koneksi internetmu…",
    networkPoor:
      "Koneksimu kurang stabil. Wawancara tetap bisa jalan, tapi mungkin hanya dengan suara (tanpa video).",
    ready: "Semua siap!",
    continue: "Lanjut",
  },
  waiting: {
    title: "Sebentar ya…",
    subtitle: "Selia sedang bersiap. Wawancara akan dimulai beberapa detik lagi.",
  },
  interview: {
    reconnecting: "Koneksi terputus — mencoba menyambung lagi…",
    audioFallback: "Sinyalmu sedang lemah, jadi kita lanjut dengan suara saja ya.",
    mute: "Bisukan mikrofon",
    unmute: "Nyalakan mikrofon",
    progress: (current: number, total: number) => `Topik ${current} dari ${total}`,
    end: "Akhiri",
    ending: "Mengakhiri…",
    endConfirmTitle: "Akhiri wawancara sekarang?",
    endConfirmBody:
      "Jawabanmu sejauh ini akan tetap dinilai, tapi kamu tidak bisa masuk lagi ke sesi ini.",
    endConfirmYes: "Ya, akhiri wawancara",
    endConfirmNo: "Lanjutkan dulu",
  },
  closing: {
    title: "Selesai! Terima kasih ya 🙌",
    body: "Jawabanmu sudah terekam. Feedback akan dikirim ke emailmu dalam 24 jam.",
  },
  errors: {
    linkExpired: "Maaf, link wawancara ini sudah kedaluwarsa. Hubungi recruiter untuk link baru.",
    generic: "Ada kendala teknis. Coba muat ulang halaman ini ya.",
  },
} as const;
