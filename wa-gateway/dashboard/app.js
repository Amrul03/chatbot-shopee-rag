const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let currentQR = null;

async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  return res.json();
}

async function checkStatus() {
  try {
    const s = await api("/bot/status");
    const show = (id, on) => $(id).classList.toggle("hidden", !on);
    if (s.isReady) {
      $("statusText").textContent = `Terhubung (${s.botNumber || "-"})`;
      $("statusDot").className = "dot ready";
      $("botNumber").textContent = s.botNumber || "-";
      show("readySection", true); show("qrSection", false); show("startBtn", false); show("stopBtn", true);
      currentQR = null;
    } else if (s.hasQRCode || s.isInitializing) {
      $("statusText").textContent = s.hasQRCode ? "Menunggu scan QR" : "Menginisialisasi…";
      $("statusDot").className = "dot waiting";
      show("readySection", false); show("qrSection", true); show("startBtn", false); show("stopBtn", true);
      if (s.hasQRCode) loadQR();
    } else {
      $("statusText").textContent = "Bot Offline";
      $("statusDot").className = "dot";
      show("readySection", false); show("qrSection", false); show("startBtn", true); show("stopBtn", false);
      currentQR = null;
    }
  } catch {
    $("statusText").textContent = "Server offline";
    $("statusDot").className = "dot";
  }
}

async function loadQR() {
  const data = await api("/bot/qr");
  if (data.image && data.qr !== currentQR) {
    currentQR = data.qr;
    $("qrcode").innerHTML = `<img width="280" height="280" alt="QR Code WhatsApp" src="${data.image}">`;
  }
}

async function loadQuota(fresh = false) {
  try {
    const q = await api(`/groq/quota${fresh ? "?fresh=true" : ""}`);
    if (!q.configured) {
      $("modelVal").textContent = "GROQ_API_KEY belum diisi";
      return;
    }
    $("modelVal").textContent = q.model || "-";
    $("lastChecked").textContent = `Pembaruan: ${q.lastChecked || "-"}`;
    const setBar = (val, lim, valEl, barEl, colorize) => {
      if (val == null || lim == null) { $(valEl).textContent = "Menunggu data"; return; }
      $(valEl).textContent = `${val.toLocaleString("id-ID")} / ${lim.toLocaleString("id-ID")}`;
      const pct = Math.max(0, Math.min(100, (val / lim) * 100));
      $(barEl).style.width = `${pct}%`;
      if (colorize) $(barEl).className = pct < 20 ? "danger" : pct < 50 ? "warning" : "";
    };
    setBar(q.remainingRequests, q.limitRequests, "reqVal", "reqBar", true);
    setBar(q.remainingTokens, q.limitTokens, "tokVal", "tokBar", false);
    if (q.resetRequests) $("reqReset").textContent = `Reset: ${q.resetRequests}`;
  } catch (e) {
    console.warn(e);
  }
}

async function loadLogs() {
  const { logs } = await api("/logs");
  if (!logs.length) return;
  $("logs").innerHTML = logs.map(l => `
    <div class="log">
      <div class="meta">${esc(l.time)} · ${esc(l.from)} · <span class="src">${esc(l.source)}</span></div>
      <div class="q">${esc(l.message)}</div>
      <div class="a">${esc(l.reply)}</div>
    </div>`).join("");
}

async function loadInfo() {
  const info = await api("/info");
  $("storeInfo").textContent = `${info.store.name} · ${info.productCount} produk (${info.categories.join(", ")}) · Groq AI + RAG`;
}

function bindAction(id, path, busyText, confirmText) {
  $(id).onclick = async () => {
    if (confirmText && !confirm(confirmText)) return;
    const btn = $(id), label = btn.textContent;
    btn.disabled = true; btn.textContent = busyText;
    try {
      const r = await api(path, { method: "POST" });
      if (r.message && path === "/bot/reset") alert(r.message);
      if (r.success === false) alert("Gagal: " + (r.error || "kesalahan server"));
    } catch { alert("Gagal menghubungi server."); }
    finally { btn.disabled = false; btn.textContent = label; checkStatus(); }
  };
}
bindAction("startBtn", "/bot/start", "Memulai…");
bindAction("stopBtn", "/bot/stop", "Menghentikan…");
bindAction("resetBtn", "/bot/reset", "Mereset…", "Hapus sesi WhatsApp? Kamu harus scan QR ulang.");
$("refreshQuotaBtn").onclick = async () => {
  $("refreshQuotaBtn").disabled = true;
  await loadQuota(true);
  $("refreshQuotaBtn").disabled = false;
};

loadInfo();
checkStatus();
loadQuota();
loadLogs();
setInterval(checkStatus, 4000);
setInterval(loadLogs, 5000);
setInterval(() => loadQuota(false), 20000);
