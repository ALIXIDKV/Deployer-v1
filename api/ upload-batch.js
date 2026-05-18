// api/upload-batch.js
export default async function handler(req, res) {
  return res.status(405).json({ success: false, message: 'Batch upload tidak tersedia.' });
}