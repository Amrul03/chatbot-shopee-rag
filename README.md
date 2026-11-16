# Katalog DJI Official Store + Chatbot RAG (Web & WhatsApp)

Tugas modul praktikum **AI Chatbot dengan RAG via WA**: website katalog lapak Shopee (deploy ke Vercel) dengan chatbot RAG, plus gateway WhatsApp yang memakai chatbot dan data yang **sama**.

- Lapak Shopee: https://shopee.co.id/shop/364304967 (DJI Official Store)
- Data: `data/products.csv` (42 produk hasil scraping, 6 kategori)

## Arsitektur

```
data/products.csv ─┐
data/knowledge.json├─► lib/rag.js  (parser CSV + retrieval TF-IDF, filter kategori/harga/diskon)
data/store.json   ─┘        │
                            ▼
                       lib/bot.js  (template sapaan → FAQ → RAG + riwayat + Groq LLM)
                        │       │
        ┌───────────────┘       └────────────────┐
        ▼                                         ▼
 api/chat.js, api/products.js            wa-gateway/server.js
 (Vercel Serverless)                     (lokal: whatsapp-web.js + Express)
        ▲                                         ▲
 public/ (website katalog + widget chat)   WhatsApp pelanggan
```

| Folder / file | Fungsi |
|---|---|
| `lib/rag.js` | Mesin RAG: parse CSV (mendukung field ber-tanda kutip), skor TF-IDF, deteksi kategori, rentang harga ("di bawah 5 juta", "antara 1jt–1,5jt"), termurah/termahal, diskon |
| `lib/bot.js` | Logika jawaban berlapis, dipakai bersama web & WA |
| `api/chat.js` | `POST /api/chat` `{ message, history }` → `{ reply, source }` |
| `api/products.js` | `GET /api/products` → katalog + info toko |
| `public/` | Website katalog (filter, pencarian, tombol Shopee & WhatsApp, widget chat) |
| `wa-gateway/` | Gateway WhatsApp + dashboard (QR, status, kuota Groq, log). **Tidak** ikut di-deploy ke Vercel |
| `data/store.json` | Nama toko, link lapak, **nomor WhatsApp bot** |

## 1. Persiapan

```bash
npm install                 # dependensi inti (groq-sdk, dotenv)
cd wa-gateway && npm install  # dependensi gateway WA (mengunduh Chromium, agak lama)
```

Salin `.env.example` menjadi `.env` (di folder utama), isi `GROQ_API_KEY` dari https://console.groq.com/keys.

Edit `data/store.json` → ganti `"waNumber": "62xxxxxxxxxx"` dengan nomor WhatsApp **bot** (format 62…, tanpa + atau spasi). Nomor ini dipakai tombol "Tanya via WA" di website.

## 2. Menjalankan lokal (website + bot WhatsApp)

```bash
cd wa-gateway
npm run dev
```

- Website: http://localhost:3001
- Dashboard bot: http://localhost:3001/dashboard/ → klik **Mulai Bot** → pindai QR dari HP (WhatsApp → Perangkat tertaut → Tautkan perangkat)

> Gunakan nomor WhatsApp cadangan. whatsapp-web.js bukan API resmi.

Uji retrieval tanpa AI: `npm run test:rag` atau `node scripts/test-rag.js "drone di bawah 5 juta"`.

## 3. Deploy website ke Vercel

1. Push folder ini ke repository GitHub (`.env`, `node_modules`, sesi WA sudah di-`.gitignore`).
2. https://vercel.com → **Add New Project** → import repo.
3. Sebelum Deploy, buka **Environment Variables** dan isi `GROQ_API_KEY` (opsional `GROQ_MODEL`, `GROQ_MAX_TOKENS`, `RAG_TOP_K`).
4. **Deploy**. `vercel.json` sudah mengatur folder `public/` sebagai website dan menyertakan `data/` ke fungsi API.

Jika lupa mengisi `GROQ_API_KEY`, chatbot tetap berjalan dalam mode katalog (label "Katalog (offline)"). Tambahkan variabelnya lalu **Redeploy**.

## 4. Skenario pengujian (untuk laporan)

| Pesan uji | Lapisan yang menjawab |
|---|---|
| `halo` | Template sapaan (tanpa AI) |
| `cara pesan` / `pembayaran` / `ongkir` | FAQ `knowledge.json` (tanpa AI) |
| `ada drone apa aja?` | RAG + Groq |
| `drone di bawah 5 juta` | RAG (filter harga) + Groq |
| `berapa harga osmo pocket 4?` lalu `kalau yang 4P?` | RAG + riwayat + Groq |
| `yang lagi diskon apa aja` | RAG (filter diskon) + Groq |
| `ada iphone?` | Groq menjawab jujur bahwa produk tidak tersedia |
| `terima kasih` | Template terima kasih (tanpa AI) |

Di widget chat website, label kecil di bawah tiap balasan (TEMPLATE / FAQ / AI + RAG) menunjukkan lapisan yang menjawab. Di dashboard WA, log menampilkan label yang sama.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| QR tidak muncul, halaman "Download WhatsApp" | Sudah ditangani dengan `userAgent` Chrome terbaru di `server.js`. Jika WhatsApp memperbarui lagi, set `WA_USER_AGENT` di `.env` |
| `The browser is already running` | Klik **Reset Sesi WA** di dashboard, atau hapus `wa-gateway/.wwebjs_auth` |
| `A database error occurred on your browser` | Pastikan folder project tidak berada di path yang sangat panjang (batas 260 karakter Windows) |
| Bot menjawab "AI sedang offline" | Isi `GROQ_API_KEY` di `.env` (lokal) atau Environment Variables (Vercel) |
| `[Groq ...] gagal` | Model tidak tersedia/kuota habis; server otomatis mencoba model cadangan. Ganti `GROQ_MODEL` dengan model aktif di console Groq |
