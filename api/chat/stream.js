const { initFirebaseAdmin, setCors } = require('../../../lib/_firebase');

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = initFirebaseAdmin();
    const snapshot = await db.collection('chat_messages')
      .orderBy('timestamp', 'desc')
      .limit(60)
      .get();

    const messages = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      messages.push({
        id: doc.id,
        username: data.username,
        text: data.text,
        timestamp: data.timestamp ? data.timestamp.toDate().getTime() : Date.now(),
        color: data.color || '#a970ff',
        isAdmin: !!data.isAdmin
      });
    });

    return res.status(200).json({ type: 'chatList', data: messages.reverse() });
  } catch (error) {
    console.error('[api/chat/stream] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
