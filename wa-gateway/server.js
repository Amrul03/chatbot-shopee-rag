// Gateway WhatsApp — dijalankan LOKAL (butuh proses latar belakang untuk menjaga sesi WhatsApp Web).
// Memakai inti chatbot yang SAMA dengan website Vercel (../lib/bot.js + ../data/products.csv),
// sehingga jawaban di WhatsApp dan di website konsisten.
//
//   http://localhost:3001/            → website katalog (sama dengan versi Vercel)
//   http://localhost:3001/dashboard/  → dashboard bot WhatsApp (QR, status, kuota Groq, log)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const fs = require("fs");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const { respond, rag, knowledge, store, getGroq } = require("../lib/bot");
const chatHandler = require("../api/chat");
const productsHandler = require("../api/products");

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// ================= STATE BOT =================
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;
const recentLogs = []; // log percakapan terakhir untuk dashboard (nomor disamarkan)

// ================= KUOTA GROQ =================
const groqQuota = {
  model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
  remainingRequests: null, limitRequests: null,
  remainingTokens: null, limitTokens: null,
  resetRequests: null, lastChecked: null,
  configured: Boolean(getGroq())
};

function updateGroqQuota(headers, model) {
  if (!headers) return;
  const get = k => (headers.get ? headers.get(k) : headers[k]);
  const num = v => (v != null ? Number(v) : null);
  groqQuota.model = model || groqQuota.model;
  groqQuota.remainingRequests = num(get("x-ratelimit-remaining-requests")) ?? groqQuota.remainingRequests;
  groqQuota.limitRequests = num(get("x-ratelimit-limit-requests")) ?? groqQuota.limitRequests;
  groqQuota.remainingTokens = num(get("x-ratelimit-remaining-tokens")) ?? groqQuota.remainingTokens;
  groqQuota.limitTokens = num(get("x-ratelimit-limit-tokens")) ?? groqQuota.limitTokens;
  groqQuota.resetRequests = get("x-ratelimit-reset-requests") || groqQuota.resetRequests;
  groqQuota.lastChecked = new Date().toLocaleTimeString("id-ID");
  groqQuota.configured = true;
}

async function fetchGroqQuotaFresh() {
  const groq = getGroq();
  if (!groq) return groqQuota;
  const model = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  try {
    const { response } = await groq.chat.completions
      .create({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 })
      .withResponse();
    updateGroqQuota(response.headers, model);
  } catch (err) {
    console.warn("Gagal mengecek kuota Groq:", err.message);
  }
  return groqQuota;
}

// ================= RIWAYAT PERCAKAPAN PER NOMOR =================
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6;
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 menit

function getUserHistory(senderId) {
  const s = conversationHistory.get(senderId);
  if (!s) return [];
  if (Date.now() - s.lastActive > SESSION_TTL_MS) {
    conversationHistory.delete(senderId);
    return [];
  }
  return s.messages;
}

function appendUserHistory(senderId, userMsg, botReply) {
  const now = Date.now();
  let s = conversationHistory.get(senderId);
  if (!s || now - s.lastActive > SESSION_TTL_MS) s = { messages: [], lastActive: now };
  s.messages.push({ role: "user", content: userMsg }, { role: "assistant", content: botReply });
  s.messages = s.messages.slice(-MAX_HISTORY_MESSAGES);
  s.lastActive = now;
  conversationHistory.set(senderId, s);
}

function maskPhoneNumber(raw) {
  if (!raw) return null;
  const f = String(raw).split("@")[0].replace(/^62/, "08");
  return f.length >= 8 ? `${f.slice(0, 2)}${"x".repeat(f.length - 6)}${f.slice(-4)}` : f;
}

// ================= CLIENT WHATSAPP =================
function initializeClient() {
  if (client) return client;

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "chatbot", dataPath: path.join(__dirname, ".wwebjs_auth") }),
    // User-agent bawaan whatsapp-web.js (Chrome 101/macOS) dianggap usang oleh WhatsApp Web
    // sehingga yang muncul halaman "Download WhatsApp", bukan QR. Pakai UA Chrome desktop terbaru.
    userAgent: process.env.WA_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote", "--disable-gpu"]
    }
  });

  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcodeTerminal.generate(qr, { small: true });
    console.log("Pindai QR di atas atau buka dashboard: http://localhost:" + PORT + "/dashboard/");
    console.log("==================================================\n");
  });
  client.on("authenticated", () => console.log("Autentikasi WhatsApp berhasil."));
  client.on("auth_failure", msg => { console.error("Autentikasi WhatsApp gagal:", msg); isInitializing = false; });
  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    console.log("Bot WhatsApp siap digunakan");
  });
  client.on("disconnected", async reason => {
    console.log("WhatsApp terputus:", reason);
    isReady = false;
    qrCodeData = null;
    const old = client;
    client = null;
    try { if (old) await old.destroy(); } catch (e) { /* browser sudah tertutup */ }
  });

  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;
      const isPersonalChat = msg.from.endsWith("@c.us") || msg.from.endsWith("@lid");
      if (!isPersonalChat || msg.from.endsWith("@status")) return; // abaikan grup & status

      const message = msg.body.trim();
      console.log(`[Masuk ${maskPhoneNumber(msg.from)}]: ${message}`);

      const history = getUserHistory(msg.from);
      const { reply, source, model } = await respond(message, history, { onRateLimit: updateGroqQuota });
      appendUserHistory(msg.from, message, reply);

      await msg.reply(reply);
      console.log(`[Balas · ${source}${model ? " · " + model : ""}]: ${reply.slice(0, 120)}${reply.length > 120 ? "…" : ""}`);

      recentLogs.unshift({ time: new Date().toLocaleTimeString("id-ID"), from: maskPhoneNumber(msg.from), message, reply, source });
      recentLogs.length = Math.min(recentLogs.length, 30);
    } catch (err) {
      console.error("Error memproses pesan:", err);
      try {
        await msg.reply("Mohon maaf, sistem asisten sedang mengalami gangguan. Silakan coba lagi sebentar.");
      } catch (e) {
        console.error("Gagal mengirim pesan fallback:", e.message);
      }
    }
  });

  return client;
}

async function startBot() {
  if (isReady || isInitializing) return;
  isInitializing = true;
  try {
    await initializeClient().initialize();
  } catch (err) {
    isInitializing = false;
    // Tutup browser yang terlanjur terbuka agar tidak muncul error "browser is already running"
    if (client) {
      try { await client.destroy(); } catch (e) { /* abaikan */ }
    }
    client = null;
    throw err;
  }
}

// ================= ENDPOINT =================
// Endpoint chatbot & katalog — handler yang sama persis dengan Vercel
app.post("/api/chat", chatHandler);
app.get("/api/products", productsHandler);

app.get("/api/bot/status", (req, res) => {
  const botNumber = isReady && client?.info?.wid ? maskPhoneNumber(client.info.wid.user) : null;
  res.json({ isReady, isInitializing, isCleaning, hasQRCode: Boolean(qrCodeData), botNumber });
});

// QR dirender LOKAL menjadi data URL (tidak dikirim ke layanan pihak ketiga)
app.get("/api/bot/qr", async (req, res) => {
  if (!qrCodeData) return res.json({ qr: null });
  const image = await QRCode.toDataURL(qrCodeData, { width: 280, margin: 1 });
  res.json({ qr: qrCodeData.slice(-12), image });
});

app.post("/api/bot/start", async (req, res) => {
  if (isReady) return res.json({ success: true, message: "Bot sudah berjalan." });
  if (isInitializing) return res.json({ success: true, message: "Bot sedang inisialisasi..." });
  startBot().catch(err => console.error("Gagal memulai bot:", err));
  res.json({ success: true, message: "Memulai bot..." });
});

app.post("/api/bot/stop", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    qrCodeData = null;
    if (client) await client.destroy();
    client = null;
    res.json({ success: true });
  } catch (err) {
    console.error("Gagal menghentikan bot:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    isCleaning = false;
    isInitializing = false;
  }
});

app.post("/api/bot/reset", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;
    if (client) {
      try { await client.destroy(); } catch (e) { console.warn("Peringatan saat destroy client:", e.message); }
      client = null;
    }
    for (const dir of [".wwebjs_auth", ".wwebjs_cache"]) {
      const full = path.join(__dirname, dir);
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
    }
    conversationHistory.clear();
    res.json({ success: true, message: "Sesi WhatsApp dibersihkan. Silakan mulai bot dan pindai QR baru." });
  } catch (err) {
    console.error("Gagal mereset sesi:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    isCleaning = false;
  }
});

app.get("/api/groq/quota", async (req, res) => {
  if (req.query.fresh === "true" || groqQuota.remainingRequests === null) await fetchGroqQuotaFresh();
  res.json(groqQuota);
});

app.get("/api/knowledge", (req, res) => res.json(knowledge));
app.get("/api/logs", (req, res) => res.json({ logs: recentLogs }));
app.get("/api/info", (req, res) => res.json({ store, productCount: rag.products.length, categories: rag.categories }));

// Static: dashboard + website katalog (folder public yang sama dengan Vercel)
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));
app.use(express.static(path.join(__dirname, "..", "public")));

// ================= START =================
const server = app.listen(PORT, () => {
  console.log(`Website  : http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard/`);
  if (!getGroq()) console.warn("⚠  GROQ_API_KEY belum diisi di .env — bot hanya menjawab template/FAQ/katalog.");
  if (process.env.AUTO_START_BOT === "true") {
    console.log("AUTO_START_BOT aktif, memulai bot WhatsApp...");
    startBot().catch(err => console.error("Auto start gagal:", err));
  }
});

async function gracefulShutdown(signal) {
  console.log(`\nMenerima ${signal}, menutup bot...`);
  if (client) {
    try { await client.destroy(); } catch (e) { /* sudah tertutup */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
// whatsapp-web.js kadang melempar error tak tertangani saat WhatsApp Web me-reload halaman
// (mis. "Execution context was destroyed"). Catat saja agar server tidak ikut mati.
process.on("unhandledRejection", err => {
  console.warn("[unhandledRejection]", err && err.message ? err.message : err);
});
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
