// Vercel Serverless Function: GET /api/products → katalog + info toko (sumber data yang sama dengan chatbot)
const { rag, store } = require("../lib/bot");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  const products = rag.products.map(p => ({
    id: p.id,
    nama: p.nama,
    kategori: p.kategori,
    harga: p.harga,
    diskon: p.diskonPersen,
    rating: p.rating,
    deskripsi: p.deskripsi,
    keunggulan: p.keunggulanList,
    link: p.link
  }));
  res.status(200).json({ store, categories: rag.categories, products });
};
