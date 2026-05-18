// api/finalize.js
export default async function handler(req, res) {
  return res.status(405).json({ success: false, message: 'Finalize tidak digunakan.' });
}