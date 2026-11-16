// Vercel Serverless Function: POST /api/chat  { message, history: [{role, content}] }
// Juga dipakai ulang oleh wa-gateway/server.js (Express) untuk menjalankan website secara lokal.
const { respond } = require("../lib/bot");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Gunakan metode POST" });
  }
  try {
    let body = req.body || {};
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const { message, history } = body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Field 'message' wajib diisi" });
    }
    const result = await respond(message, history);
    return res.status(200).json(result);
  } catch (err) {
    console.error("[api/chat]", err);
    return res.status(500).json({ error: "Terjadi kesalahan pada server chatbot" });
  }
};
