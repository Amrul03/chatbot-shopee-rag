// Mesin RAG sederhana untuk katalog hasil scraping Shopee.
// - Parser CSV yang mendukung field ber-tanda kutip (nama produk berisi koma)
// - Retrieval berbasis skor TF-IDF ringan (kata umum seperti "dji" bobotnya kecil)
// - Deteksi maksud: kategori, rentang harga, termurah/termahal, diskon, katalog lengkap
const fs = require("fs");
const path = require("path");

const DEFAULT_CSV = path.join(__dirname, "..", "data", "products.csv");

// ---------- CSV ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== "")) rows.push(row);
  return rows;
}

// ---------- Teks ----------
const STOPWORDS = new Set([
  "ada", "apa", "aja", "saja", "yang", "yg", "berapa", "harga", "harganya", "dong", "kak", "min",
  "admin", "saya", "aku", "mau", "ingin", "cari", "carikan", "untuk", "buat", "dan", "atau", "ini",
  "itu", "nya", "ya", "kah", "gak", "nggak", "tidak", "bisa", "punya", "jual", "tolong", "info",
  "produk", "barang", "toko", "the", "and", "for", "with", "with", "di", "ke", "dari", "pada",
  "dengan", "rekomendasi", "rekomendasiin", "rekomen", "saran", "bagus", "paling", "tanya",
  "gimana", "bagaimana", "apakah", "berapaan", "rp", "juta", "jt", "ribu", "rb", "budget",
  "bawah", "atas", "kurang", "lebih", "maksimal", "minimal", "max", "min", "sekitar", "kisaran",
  "termurah", "termahal", "murah", "mahal", "diskon", "promo", "sale", "ready", "stok", "stock",
  "halo", "hai", "kakak", "gan", "sis", "bang", "mas", "mbak", "pak", "bu", "tau", "tahu", "dulu",
  "dibawah", "diatas", "antara", "sampai", "sampe", "hingga", "range", "semua", "seluruh", "katalog",
  "daftar", "list", "koleksi", "lengkap", "dong", "deh", "sih", "kah", "jual", "terbaik", "terlaris",
  "best", "rating", "review", "bintang", "potongan", "discount", "hemat", "premium", "tertinggi", "terendah"
]);

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/(\D)\.|\.(\D)|\.$/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

const PRICE_PHRASE = /(rp\.?\s*)?\d+(?:[.,]\d+)*\s*(jt|juta|rb|ribu|k)\b|rp\.?\s*\d+(?:[.,]\d+)*/gi;

function tokenize(text, { stripPrice = false } = {}) {
  let t = String(text || "");
  if (stripPrice) t = t.replace(PRICE_PHRASE, " ");
  return normalize(t).split(" ").filter(w =>
    w.length > 1 && !STOPWORDS.has(w) && !(stripPrice && /^\d{5,}$/.test(w)));
}

// Kata kunci kategori (satu kata). Dipakai sebagai filter keras HANYA jika
// pertanyaan tidak menyebut kata spesifik lain (mis. "drone termurah").
const CATEGORY_SYNONYMS = {
  drone: ["drone", "dron", "drones", "quadcopter", "fpv"],
  kamera: ["kamera", "camera", "cam", "actioncam", "vlog", "vlogging"],
  gimbal: ["gimbal", "stabilizer", "stabiliser"],
  mikrofon: ["mic", "mik", "mikrofon", "microphone", "clipon"],
  aksesoris: ["aksesoris", "aksesori", "accessories", "accessory", "sparepart"],
  "robot vacuum": ["vacuum", "vakum", "penyedot", "robot"]
};

// ---------- Harga ----------
function parseAmount(numStr, unit) {
  const raw = String(numStr);
  unit = (unit || "").toLowerCase();
  // "1.3jt" / "1,5 juta" → desimal; "1.500.000" → pemisah ribuan
  let n = /^\d+[.,]\d{1,2}$/.test(raw) && unit
    ? Number(raw.replace(",", "."))
    : Number(raw.replace(/[.,]/g, ""));
  if (isNaN(n)) return null;
  if (/^(jt|juta|j)$/.test(unit)) n *= 1e6;
  else if (/^(rb|ribu|k)$/.test(unit)) n *= 1e3;
  return n;
}

function extractPriceRange(query) {
  const q = query.toLowerCase();
  const num = "(\\d+(?:[.,]\\d+)*)\\s*(jt|juta|j|rb|ribu|k)?\\b";
  const range = { min: null, max: null };
  let m;
  if ((m = q.match(new RegExp(`(?:antara|range|dari)\\s*(?:rp\\.?\\s*)?${num}\\s*(?:-|sampai|sampe|hingga|s\\/d|to|ke)\\s*(?:rp\\.?\\s*)?${num}`)))) {
    range.min = parseAmount(m[1], m[2] || m[4]);
    range.max = parseAmount(m[3], m[4]);
    return range;
  }
  if ((m = q.match(new RegExp(`(?:di\\s*bawah|dibawah|kurang\\s*dari|max(?:imal)?|maks(?:imal)?|budget|bujet|<=?|gak\\s*sampai|ga\\s*sampai|tidak\\s*sampai)\\s*(?:rp\\.?\\s*)?${num}`)))) {
    range.max = parseAmount(m[1], m[2]);
  }
  if ((m = q.match(new RegExp(`(?:di\\s*atas|diatas|lebih\\s*dari|min(?:imal)?|>=?)\\s*(?:rp\\.?\\s*)?${num}`)))) {
    range.min = parseAmount(m[1], m[2]);
  }
  return range;
}

function formatRupiah(value) {
  const n = Number(value);
  if (isNaN(n)) return String(value);
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

// ---------- Engine ----------
class RAGEngine {
  constructor(csvPath = DEFAULT_CSV, options = {}) {
    this.csvPath = csvPath;
    this.topK = options.topK || Number(process.env.RAG_TOP_K || 8);
    this.products = [];
    this.categories = [];
    this.loadData();
  }

  loadData() {
    try {
      if (!fs.existsSync(this.csvPath)) {
        console.warn(`[RAG] File CSV tidak ditemukan: ${this.csvPath}`);
        this.products = [];
        return;
      }
      const rows = parseCSV(fs.readFileSync(this.csvPath, "utf-8").replace(/^﻿/, ""));
      const headers = rows[0].map(h => h.trim().toLowerCase());
      this.products = rows.slice(1).map((cols, idx) => {
        const p = { id: idx + 1 };
        headers.forEach((h, i) => { p[h] = (cols[i] || "").trim(); });
        p.harga = Number(p.harga) || 0;
        p.rating = p.rating ? Number(p.rating) : null;
        p.diskonPersen = p.diskon ? Number(String(p.diskon).replace("%", "")) || 0 : 0;
        p.keunggulanList = p.keunggulan ? p.keunggulan.split(";").map(s => s.trim()).filter(Boolean) : [];
        return p;
      });
      this.categories = [...new Set(this.products.map(p => p.kategori).filter(Boolean))];
      this.buildIndex();
      console.log(`[RAG] ${this.products.length} produk dimuat, kategori: ${this.categories.join(", ")}`);
    } catch (err) {
      console.error("[RAG] Gagal memuat CSV:", err);
      this.products = [];
    }
  }

  // Indeks token per field + IDF
  buildIndex() {
    const df = new Map();
    this.docs = this.products.map(p => {
      const fields = {
        nama: new Set(tokenize(p.nama)),
        kategori: new Set(tokenize(p.kategori)),
        deskripsi: new Set(tokenize(p.deskripsi)),
        keunggulan: new Set(tokenize(p.keunggulan))
      };
      const all = new Set([...fields.nama, ...fields.kategori, ...fields.deskripsi, ...fields.keunggulan]);
      all.forEach(t => df.set(t, (df.get(t) || 0) + 1));
      return { product: p, fields, all, nameNorm: normalize(p.nama) };
    });
    this.vocab = new Set(df.keys());
    const N = this.products.length;
    this.idf = t => Math.log(1 + N / (1 + (df.get(t) || 0)));
  }

  // Kembalikan { category, categoryWords } dari kata kategori yang disebut pengguna
  detectCategory(tokens) {
    const words = new Set();
    let category = null;
    for (const t of tokens) {
      for (const cat of this.categories) {
        const key = cat.toLowerCase();
        const syn = [...key.split(" "), ...(CATEGORY_SYNONYMS[key] || [])];
        if (syn.includes(t)) { words.add(t); if (!category) category = cat; }
      }
    }
    return { category, categoryWords: words };
  }

  detectIntent(query) {
    const q = normalize(query);
    return {
      all: /\b(semua|seluruh|katalog|daftar|list|koleksi|apa aja|apa saja|produknya apa|jual apa)\b/.test(q),
      cheapest: /\b(termurah|paling murah|murah|harga terendah|budget|hemat)\b/.test(q),
      priciest: /\b(termahal|paling mahal|tertinggi|flagship|premium)\b/.test(q),
      discount: /\b(diskon|promo|sale|potongan|discount)\b/.test(q),
      rating: /\b(rating|terbaik|terlaris|best|review|bintang)\b/.test(q)
    };
  }

  search(query, k = this.topK) {
    if (!query || this.products.length === 0) return { products: [], meta: {} };
    const range = extractPriceRange(query);
    const intent = this.detectIntent(query);
    const qNorm = normalize(query);
    const tokens = [...new Set(tokenize(query, { stripPrice: true }))];
    const { category, categoryWords } = this.detectCategory(tokens);
    // Kata yang tidak ada di katalog (mis. "hp", "buat") diabaikan
    const contentTokens = tokens.filter(t => !categoryWords.has(t) && this.vocab.has(t));
    // Kategori jadi filter keras hanya bila tidak ada kata spesifik lain
    const hardCategory = category && contentTokens.length === 0 ? category : null;

    let candidates = this.docs;
    if (hardCategory) candidates = candidates.filter(d => d.product.kategori === hardCategory);
    if (range.min != null) candidates = candidates.filter(d => d.product.harga >= range.min);
    if (range.max != null) candidates = candidates.filter(d => d.product.harga <= range.max);
    if (intent.discount) candidates = candidates.filter(d => d.product.diskonPersen > 0);

    const scored = candidates.map(d => {
      let score = 0;
      for (const t of contentTokens) {
        const w = this.idf(t);
        if (d.fields.nama.has(t)) score += 3 * w;
        if (d.fields.kategori.has(t)) score += 1.5 * w;
        if (d.fields.deskripsi.has(t)) score += 1 * w;
        if (d.fields.keunggulan.has(t)) score += 1 * w;
      }
      // Bonus frasa: nama produk persis disebut (mis. "osmo pocket 4")
      const shortName = d.nameNorm.replace(/^dji\s+/, "").split(" - ")[0];
      if (shortName.length > 3 && qNorm.includes(shortName)) score += 10 + shortName.length / 5;
      // Kategori yang disebut menjadi bonus (bukan filter) bila ada kata spesifik
      if (score > 0 && category && d.product.kategori === category) score += 2;
      return { d, score };
    });

    const filtered = Boolean(hardCategory || range.min != null || range.max != null || intent.discount);
    const hasTokenHits = scored.some(s => s.score > 0);
    let result;

    if (hasTokenHits) {
      result = scored.filter(s => s.score > 0);
      result.sort((a, b) => b.score - a.score);
    } else if (filtered || intent.all || intent.cheapest || intent.priciest || intent.rating) {
      result = scored; // tidak ada kata kunci spesifik → pakai seluruh kandidat hasil filter
    } else {
      return { products: [], meta: { category: hardCategory, range, intent } };
    }

    let products = result.map(s => s.d.product);
    if (intent.cheapest) products = [...products].sort((a, b) => a.harga - b.harga);
    else if (intent.priciest) products = [...products].sort((a, b) => b.harga - a.harga);
    else if (intent.discount) products = [...products].sort((a, b) => b.diskonPersen - a.diskonPersen);
    else if (intent.rating && !hasTokenHits) products = [...products].sort((a, b) => (b.rating || 0) - (a.rating || 0));

    // Permintaan katalog lengkap tanpa filter → kembalikan semua (ringkas)
    const limit = intent.all && !hasTokenHits ? products.length : k;
    return { products: products.slice(0, limit), meta: { category: hardCategory || category, range, intent, total: products.length } };
  }

  formatProduct(p, compact = false) {
    let line = `• ${p.nama} — ${formatRupiah(p.harga)}`;
    if (p.diskonPersen) line += ` (diskon ${p.diskonPersen}%)`;
    if (p.rating) line += ` ★${p.rating}`;
    if (compact) return line;
    if (p.deskripsi && p.deskripsi !== p.nama) line += `\n  Deskripsi: ${p.deskripsi}`;
    if (p.keunggulanList.length) line += `\n  Keunggulan: ${p.keunggulanList.join(", ")}`;
    line += `\n  Link Shopee: ${p.link}`;
    return line;
  }

  buildContext(query) {
    const { products, meta } = this.search(query);
    if (!products.length) return "";
    const compact = products.length > this.topK;
    const grouped = {};
    for (const p of products) (grouped[p.kategori || "Lainnya"] ||= []).push(p);
    let out = `Konteks Katalog Toko (${products.length} produk relevan dari total ${this.products.length}):\n`;
    if (meta.range && (meta.range.min != null || meta.range.max != null)) {
      out += `Filter harga: ${meta.range.min != null ? "≥ " + formatRupiah(meta.range.min) : ""} ${meta.range.max != null ? "≤ " + formatRupiah(meta.range.max) : ""}\n`;
    }
    for (const [cat, items] of Object.entries(grouped)) {
      out += `\n[Kategori: ${cat}]\n` + items.map(p => this.formatProduct(p, compact)).join("\n") + "\n";
    }
    return out.trim();
  }

  summary() {
    const counts = {};
    for (const p of this.products) counts[p.kategori] = (counts[p.kategori] || 0) + 1;
    return Object.entries(counts).map(([c, n]) => `${c} (${n})`).join(", ");
  }
}

module.exports = { RAGEngine, parseCSV, formatRupiah, extractPriceRange, normalize, tokenize };
