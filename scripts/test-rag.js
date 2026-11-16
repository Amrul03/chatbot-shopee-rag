// Uji cepat retrieval RAG tanpa memanggil AI:  npm run test:rag  [atau]  node scripts/test-rag.js "drone di bawah 5 juta"
const { RAGEngine } = require("../lib/rag");
const rag = new RAGEngine();
const queries = process.argv.slice(2).length ? process.argv.slice(2) : [
  "ada drone apa aja?", "drone di bawah 5 juta", "kamera termurah", "berapa harga osmo pocket 4",
  "gimbal buat hp", "yang lagi diskon apa aja", "ada filter ND untuk mini 5 pro", "mic antara 1jt sampai 1.3jt"
];
for (const q of queries) {
  const { products } = rag.search(q);
  console.log(`\n> ${q}  (${products.length} produk)`);
  products.slice(0, 5).forEach(p => console.log(`   ${p.kategori.padEnd(12)} ${String(p.harga).padStart(9)}  ${p.nama}`));
}
