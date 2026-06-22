const { initFirebaseAdmin, parseBody, setCors } = require('../../../lib/_firebase');

module.exports = async (req, res) => {
  setCors(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseBody(req);
  const id = String(body.id || '').trim();

  if (!id) {
    return res.status(400).json({ error: 'Missing document id' });
  }

  try {
    const db = initFirebaseAdmin();
    await db.collection('chat_messages').doc(id).delete();
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[api/chat/delete] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
