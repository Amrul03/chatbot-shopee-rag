// Frontend katalog + widget chat. Data produk diambil dari /api/products (sumber CSV yang sama dengan chatbot).
const API = "/api";
const $ = id => document.getElementById(id);

const state = { products: [], categories: [], store: {}, category: "Semua", query: "", sort: "default" };
const chat = { history: [], busy: false };

const rupiah = n => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
const escapeHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const waLink = text => {
  const num = (state.store.waNumber || "").replace(/\D/g, "");
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
};
const shortName = name => name.replace(/^\[[^\]]*\]\s*/, "").split(" - ")[0];

// ---------- Katalog ----------
async function loadCatalog() {
  try {
    const res = await fetch(`${API}/products`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.products = data.products;
    state.categories = data.categories;
    state.store = data.store || {};
    renderStore();
    renderChips();
    renderGrid();
    renderWaButtons();
  } catch (err) {
    console.error(err);
    $("productGrid").innerHTML = '<div class="empty">Gagal memuat katalog. Pastikan server/API berjalan.</div>';
  }
}

function renderStore() {
  const s = state.store, p = state.products;
  $("storeName").textContent = s.name || "Toko";
  if (s.disclaimer) $("disclaimer").textContent = s.disclaimer;
  ["shopLinkNav", "shopLinkFooter"].forEach(id => ($(id).href = s.shopUrl || "#"));
  $("waHero").href = waLink(`Halo ${s.name}, saya mau tanya-tanya produk DJI. Ada rekomendasi?`);
  $("statProducts").textContent = p.length;
  $("statCategories").textContent = state.categories.length;
  $("statDiscount").textContent = p.filter(x => x.diskon > 0).length;
  $("statMin").textContent = p.length ? rupiah(Math.min(...p.map(x => x.harga))) : "–";
}

function renderChips() {
  const counts = state.products.reduce((m, p) => ((m[p.kategori] = (m[p.kategori] || 0) + 1), m), {});
  const cats = ["Semua", ...state.categories];
  $("categoryChips").innerHTML = cats.map(c => `
    <button class="chip ${c === state.category ? "active" : ""}" data-cat="${escapeHTML(c)}" role="tab" aria-selected="${c === state.category}">
      ${escapeHTML(c)}<span class="count">${c === "Semua" ? state.products.length : counts[c]}</span>
    </button>`).join("");
}

function filteredProducts() {
  const q = state.query.toLowerCase().trim();
  let list = state.products.filter(p =>
    (state.category === "Semua" || p.kategori === state.category) &&
    (!q || `${p.nama} ${p.deskripsi} ${p.kategori} ${p.keunggulan.join(" ")}`.toLowerCase().includes(q)));
  const sorters = {
    cheap: (a, b) => a.harga - b.harga,
    expensive: (a, b) => b.harga - a.harga,
    discount: (a, b) => b.diskon - a.diskon,
    name: (a, b) => shortName(a.nama).localeCompare(shortName(b.nama))
  };
  if (sorters[state.sort]) list = [...list].sort(sorters[state.sort]);
  return list;
}

function renderGrid() {
  const list = filteredProducts();
  $("resultCount").textContent = `Menampilkan ${list.length} dari ${state.products.length} produk`;
  if (!list.length) {
    $("productGrid").innerHTML = '<div class="empty">Produk tidak ditemukan. Coba kata kunci lain, atau tanya asisten AI.</div>';
    return;
  }
  $("productGrid").innerHTML = list.map(p => {
    const waText = `Halo ${state.store.name}, saya tertarik dengan ${shortName(p.nama)} (${rupiah(p.harga)}). Boleh minta info lebih lanjut?`;
    const desc = p.deskripsi && p.deskripsi !== p.nama ? p.deskripsi.replace(/^.*? - /, "").split(/\s*\|\s*/).join(" · ") : p.keunggulan.join(" · ");
    return `
    <article class="card">
      <div class="card-top">
        <span>${escapeHTML(p.kategori)}</span>
        ${p.diskon ? `<span class="sale">−${p.diskon}%</span>` : ""}
      </div>
      <h3 class="card-title">${escapeHTML(p.nama.replace(/^\[[^\]]*\]\s*/, ""))}</h3>
      ${desc ? `<p class="card-desc">${escapeHTML(desc)}</p>` : ""}
      <div class="price-row">
        <span class="price">${rupiah(p.harga)}</span>
        ${p.rating ? `<span class="rating">★ ${p.rating.toFixed(1)}</span>` : ""}
      </div>
      <div class="card-actions">
        <a href="${escapeHTML(p.link)}" target="_blank" rel="noopener">Shopee ↗</a>
        <a href="${escapeHTML(waLink(waText))}" target="_blank" rel="noopener">Tanya via WA</a>
      </div>
    </article>`;
  }).join("");
}

function renderWaButtons() {
  const templates = {
    Drone: "Halo, saya mau cari drone. Ada rekomendasi drone apa saja beserta harganya?",
    Kamera: "Halo, saya mau tanya kamera (action cam / pocket / 360). Ada pilihan apa saja?",
    Gimbal: "Halo, saya butuh gimbal. Ada gimbal apa saja dan berapa harganya?",
    Mikrofon: "Halo, saya mau cari mic wireless. Ada mikrofon apa saja?",
    Aksesoris: "Halo, saya mau lihat aksesoris yang tersedia. Ada apa saja?",
    "Robot Vacuum": "Halo, saya tertarik dengan robot vacuum. Ada produk apa?"
  };
  $("waCategoryButtons").innerHTML = state.categories.map(c => {
    const text = templates[c] || `Halo, saya mau tanya produk kategori ${c}. Ada apa saja?`;
    return `<a class="wa-card" href="${escapeHTML(waLink(text))}" target="_blank" rel="noopener">${escapeHTML(c)}<span>→</span></a>`;
  }).join("");
}

$("categoryChips").addEventListener("click", e => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  state.category = btn.dataset.cat;
  renderChips();
  renderGrid();
});
$("searchInput").addEventListener("input", e => { state.query = e.target.value; renderGrid(); });
$("sortSelect").addEventListener("change", e => { state.sort = e.target.value; renderGrid(); });

// ---------- Chat ----------
const SUGGESTIONS = ["Drone di bawah 5 juta", "Kamera untuk vlog", "Produk yang lagi diskon", "Gimbal buat HP", "Cara pesan"];
const SOURCE_LABEL = { template: "Template", faq: "FAQ", ai: "AI + RAG", fallback: "Katalog (offline)" };

// *bold*, _italic_, link, dengan escape HTML terlebih dahulu
function renderRich(text) {
  return escapeHTML(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, url => `<a href="${url}" target="_blank" rel="noopener">${url.length > 48 ? url.slice(0, 45) + "…" : url}</a>`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?:)]|$)/g, "$1<strong>$2</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?:)]|$)/g, "$1<em>$2</em>");
}

function addMessage(role, text, source) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = renderRich(text) + (source ? `<span class="msg-meta">${SOURCE_LABEL[source] || source}</span>` : "");
  $("chatBody").appendChild(el);
  $("chatBody").scrollTop = $("chatBody").scrollHeight;
  return el;
}

function greet() {
  $("chatBody").innerHTML = "";
  addMessage("bot", `Halo! 👋 Saya asisten belanja *${state.store.name || "toko"}*. Tanya apa saja soal produk di lapak ini: harga, rekomendasi sesuai budget, atau produk yang sedang diskon.`);
  $("chatSuggest").innerHTML = SUGGESTIONS.map(s => `<button type="button">${escapeHTML(s)}</button>`).join("");
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || chat.busy) return;
  chat.busy = true;
  $("chatInput").value = "";
  $("chatForm").querySelector("button").disabled = true;
  addMessage("user", text);
  const typing = addMessage("bot", "");
  typing.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  try {
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: chat.history.slice(-6) })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    typing.remove();
    addMessage("bot", data.reply, data.source);
    chat.history.push({ role: "user", content: text }, { role: "assistant", content: data.reply });
    chat.history = chat.history.slice(-6);
  } catch (err) {
    typing.remove();
    addMessage("bot", "Maaf, terjadi gangguan saat menghubungi asisten. Coba lagi sebentar ya.");
    console.error(err);
  } finally {
    chat.busy = false;
    $("chatForm").querySelector("button").disabled = false;
    $("chatInput").focus();
  }
}

function openChat() {
  $("chatPanel").hidden = false;
  if (!$("chatBody").children.length) greet();
  $("chatInput").focus();
}
$("chatFab").addEventListener("click", () => ($("chatPanel").hidden ? openChat() : ($("chatPanel").hidden = true)));
$("openChatHero").addEventListener("click", openChat);
$("chatClose").addEventListener("click", () => ($("chatPanel").hidden = true));
$("chatReset").addEventListener("click", () => { chat.history = []; greet(); });
$("chatForm").addEventListener("submit", e => { e.preventDefault(); sendMessage($("chatInput").value); });
$("chatSuggest").addEventListener("click", e => { if (e.target.tagName === "BUTTON") sendMessage(e.target.textContent); });

loadCatalog();
