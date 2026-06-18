const { admin, initFirebaseAdmin, parseBody, setCors } = require('../_firebase');

module.exports = async (req, res) => {
  setCors(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseBody(req);
  const username = String(body.username || '').trim();
  const text = String(body.text || '').trim();

  if (!username || !text) {
    return res.status(400).json({ error: 'Missing username or text' });
  }

  try {
    const db = initFirebaseAdmin();
    await db.collection('chat_messages').add({
      username,
      text,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      color: body.color || '#a970ff',
      isAdmin: !!body.isAdmin
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[api/chat/send] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
