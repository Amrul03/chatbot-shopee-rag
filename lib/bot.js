// Inti chatbot yang DIPAKAI BERSAMA oleh website (Vercel /api/chat) dan gateway WhatsApp.
// Alur berlapis (seperti modul praktikum):
//   1. Sapaan / terima kasih  → template (tanpa AI)
//   2. FAQ knowledge.json      → jawaban manual (tanpa AI)
//   3. Lainnya                 → RAG (data/products.csv) + riwayat chat + Groq LLM
const fs = require("fs");
const path = require("path");
const Groq = require("groq-sdk");
const { RAGEngine } = require("./rag");

// require() agar file data otomatis ikut ter-bundle ke Vercel Serverless Function
const store = require("../data/store.json");
const knowledge = require("../data/knowledge.json");
const rag = new RAGEngine();

const MAX_HISTORY_MESSAGES = 6;

// Konteks RAG → teks yang layak ditampilkan langsung ke pelanggan (dipakai saat AI tidak tersedia)
function contextToReply(ctx) {
  return ctx
    .split("\n")
    .filter(l => !/^(Konteks Katalog Toko|Filter harga|  Deskripsi:)/.test(l))
    .map(l => l.replace(/^\[Kategori: (.+)\]$/, "*$1*"))
    .join("\n")
    .trim();
}

function fillStoreVars(text) {
  return text.replace(/\{(\w+)\}/g, (m, key) => (store[key] != null ? store[key] : m));
}

// ---------- Format ----------
function formatChatMessage(text) {
  if (!text) return "";
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "") // model reasoning (qwen, dll.)
    .replace(/\*\*(.*?)\*\*/g, "*$1*")         // **bold** → *bold* (format WhatsApp)
    .replace(/^#{1,6}\s*(.+)$/gm, "*$1*")       // heading markdown → bold
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- Deteksi pesan sederhana ----------
const PRODUCT_WORDS = ["produk", "harga", "katalog", "jual", "beli", "drone", "kamera", "gimbal", "mic", "osmo", "dji", "aksesoris", "filter", "baterai"];

function isGreetingMessage(text) {
  const q = text.toLowerCase().trim().replace(/[!.?,]+$/g, "");
  const exact = ["halo", "hai", "hi", "hey", "hello", "hei", "p", "ping", "test", "tes", "pagi", "siang", "sore", "malam",
    "selamat pagi", "selamat siang", "selamat sore", "selamat malam", "assalamualaikum", "assalamu'alaikum",
    "assalamu alaikum", "permisi", "halo kak", "halo min", "hai kak", "hai min"];
  if (exact.includes(q)) return true;
  if (/^(halo|hai|hi|hey|hello|hei|selamat\s+(pagi|siang|sore|malam)|assalamu.?\s*alaikum|permisi)\b/i.test(q) && q.length < 40) {
    return !PRODUCT_WORDS.some(w => q.includes(w)) && !q.includes("?");
  }
  return false;
}

function isGratitudeMessage(text) {
  const q = text.toLowerCase().trim().replace(/[!.?,]+$/g, "");
  return /^(terima\s*kasih|makasih|makasi|thanks|thank\s*you|thx|tq|matur\s*nuwun|nuhun|syukron|oke\s*makasih|ok\s*makasih)\b/i.test(q) && q.length < 50;
}

function matchFAQ(text) {
  const q = text.toLowerCase();
  for (const [kw, key] of Object.entries(knowledge.keywords || {})) {
    const re = new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(q) && knowledge.responses[key]) {
      // Kalau pesan juga menanyakan produk tertentu (mis. "cara order osmo pocket 4"),
      // biarkan AI + RAG yang menjawab agar produknya ikut dibahas.
      const rest = q.replace(re, " ");
      if (rag.search(rest).products.length > 0) return null;
      return { key, reply: fillStoreVars(knowledge.responses[key]) };
    }
  }
  return null;
}

// ---------- Groq ----------
let groq = null;
function getGroq() {
  const key = process.env.GROQ_API_KEY;
  if (!key || key.startsWith("gsk_isi")) return null;
  if (!groq) groq = new Groq({ apiKey: key });
  return groq;
}

function buildSystemPrompt(ragContext) {
  return `Kamu adalah asisten belanja ramah untuk lapak Shopee "${store.name}" yang menjual produk DJI: drone, kamera aksi/pocket/360, gimbal, mikrofon wireless, aksesoris, dan robot vacuum. Jawab dalam Bahasa Indonesia yang santai, sopan, natural, dan to the point.

ATURAN KEAKURATAN (WAJIB):
- Jawab HANYA berdasarkan "Konteks Katalog Toko" di bawah. Nama produk, harga, diskon, rating, deskripsi, dan link harus PERSIS seperti di konteks.
- JANGAN mengarang spesifikasi, stok, varian, warna, ongkir, atau harga yang tidak ada di konteks. Jika ditanya hal yang tidak ada, katakan informasinya bisa dicek di halaman produk Shopee dan berikan link produknya (atau link lapak: ${store.shopUrl}).
- Harga di katalog adalah harga jual saat data diambil (sudah termasuk diskon jika ada) dan bisa berubah di Shopee.
- Jika produk yang ditanyakan TIDAK ada di katalog, katakan dengan jujur bahwa produk itu tidak tersedia di lapak ini, lalu tawarkan alternatif terdekat dari konteks bila ada.
- Jangan pernah menyebut istilah teknis internal seperti "CSV", "konteks", "database", atau "RAG".
- Untuk rekomendasi, pilih maksimal 3 produk paling relevan dan jelaskan singkat alasannya berdasarkan deskripsi/keunggulan.

FORMAT (tampil di WhatsApp & chat web):
- Bold pakai SATU bintang: *teks*. Jangan pakai **dua bintang**, heading #, atau tabel.
- Setiap produk di baris terpisah dengan bullet "•", format: • *Nama Produk* — Rp x.xxx.xxx
- Sertakan link Shopee produk bila pelanggan menanyakan produk spesifik atau ingin membeli.
- Jika pelanggan minta katalog lengkap, kelompokkan per kategori, cukup nama + harga.
- Jawaban singkat (maks ±150 kata kecuali diminta daftar lengkap), emoji secukupnya, kalimat selesai tuntas.
- Jangan ucapkan "selamat datang" kecuali pelanggan baru menyapa.

Ringkasan lapak: ${rag.products.length} produk — ${rag.summary()}.

${ragContext || "Konteks Katalog Toko: (tidak ada produk yang cocok dengan pertanyaan ini). Jika pertanyaan di luar topik toko, arahkan kembali dengan sopan ke produk-produk lapak."}`;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(h => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .map(h => ({ role: h.role, content: h.content.slice(0, 2000) }))
    .slice(-MAX_HISTORY_MESSAGES);
}

/**
 * Hasilkan balasan untuk satu pesan.
 * @param {string} message      pesan pengguna
 * @param {Array}  history      riwayat [{role, content}] (maks 6 terakhir dipakai)
 * @param {object} opts         { onRateLimit(headers, model) } — opsional, untuk dashboard kuota
 * @returns {Promise<{reply: string, source: string, model?: string}>}
 */
async function respond(message, history = [], opts = {}) {
  message = String(message || "").trim().slice(0, 1000);
  if (!message) return { reply: "Silakan ketik pertanyaanmu ya 😊", source: "template" };
  history = sanitizeHistory(history);

  // 1. Template sapaan / terima kasih
  if (isGreetingMessage(message)) {
    return {
      reply: `Halo! 👋 Selamat datang di *${store.name}*.\n\nAda yang bisa saya bantu? Kamu bisa tanya harga, minta rekomendasi drone/kamera/gimbal sesuai budget, atau cek produk yang lagi diskon.`,
      source: "template"
    };
  }
  if (isGratitudeMessage(message)) {
    return {
      reply: `Sama-sama! 🙏 Senang bisa membantu.\n\nKalau mau checkout, langsung saja ke lapak kami di Shopee: ${store.shopUrl}`,
      source: "template"
    };
  }

  // 2. FAQ
  const faq = matchFAQ(message);
  if (faq) return { reply: formatChatMessage(faq.reply), source: "faq" };

  // 3. RAG — prioritaskan pesan terkini; jika kosong (mis. "berapa harganya?"),
  //    gabungkan dengan pertanyaan user sebelumnya.
  let ragContext = rag.buildContext(message);
  if (!ragContext && history.length) {
    const prev = history.filter(h => h.role === "user").slice(-2).map(h => h.content).join(" ");
    ragContext = rag.buildContext(`${prev} ${message}`);
  }

  const client = getGroq();
  if (!client) {
    return {
      reply: ragContext
        ? formatChatMessage(`Berikut produk yang cocok dari katalog kami:\n\n${contextToReply(ragContext)}`)
        : "Maaf, asisten AI sedang offline (GROQ_API_KEY belum diatur). Silakan cek katalog di halaman ini ya.",
      source: "fallback"
    };
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(ragContext) },
    ...history,
    { role: "user", content: message }
  ];
  const candidateModels = [...new Set([
    process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile"
  ])];

  let lastError = null;
  for (const model of candidateModels) {
    try {
      const { data: completion, response } = await client.chat.completions
        .create({ model, messages, max_tokens: Number(process.env.GROQ_MAX_TOKENS || 1500), temperature: 0.4 })
        .withResponse();
      if (opts.onRateLimit && response && response.headers) opts.onRateLimit(response.headers, model);
      const raw = completion.choices?.[0]?.message?.content;
      const reply = formatChatMessage(raw);
      if (reply) return { reply, source: "ai", model };
    } catch (err) {
      lastError = err;
      console.warn(`[Groq ${model}] gagal: ${err.message}. Mencoba model lain...`);
    }
  }

  console.error("[Groq] Semua model gagal:", lastError && lastError.message);
  return {
    reply: ragContext
      ? formatChatMessage(`Maaf, asisten AI sedang sibuk. Ini produk yang cocok dari katalog kami:\n\n${contextToReply(ragContext)}`)
      : `Maaf, asisten AI sedang sibuk. Silakan coba lagi sebentar, atau lihat lapak kami: ${store.shopUrl}`,
    source: "fallback"
  };
}

module.exports = { respond, rag, store, knowledge, getGroq };
