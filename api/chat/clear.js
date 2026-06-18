const { initFirebaseAdmin, setCors } = require('../_firebase');

module.exports = async (req, res) => {
  setCors(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = initFirebaseAdmin();
    const snapshot = await db.collection('chat_messages').get();
    const batch = db.batch();

    snapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    return res.status(200).json({ success: true, deleted: snapshot.size });
  } catch (error) {
    console.error('[api/chat/clear] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
