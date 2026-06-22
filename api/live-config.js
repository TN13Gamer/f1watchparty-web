const fs = require('fs');
const path = require('path');
const { initFirebaseAdmin, setCors } = require('./_firebase');

function unwrapFirestore(val) {
  if (!val || typeof val !== 'object') return val;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return parseFloat(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(unwrapFirestore);
  if ('mapValue' in val) return unwrapFirestoreMap(val.mapValue.fields || {});
  return val;
}

function unwrapFirestoreMap(fields) {
  const res = {};
  if (!fields) return res;
  for (const k in fields) {
    res[k] = unwrapFirestore(fields[k]);
  }
  return res;
}

function loadBackupConfig() {
  const backupPath = path.resolve(process.cwd(), 'firestore_live_config_utf8.json');
  if (!fs.existsSync(backupPath)) return {};
  let rawContent = fs.readFileSync(backupPath, 'utf8');
  if (rawContent.charCodeAt(0) === 0xFEFF) {
    rawContent = rawContent.slice(1);
  }
  const rawBackup = JSON.parse(rawContent);
  if (rawBackup && rawBackup.fields) {
    return unwrapFirestoreMap(rawBackup.fields);
  }
  return {};
}

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = initFirebaseAdmin();
    const doc = await db.collection('app_data').doc('live_config').get();
    if (doc.exists) {
      return res.json(doc.data());
    }
  } catch (e) {
    console.warn('[api/live-config] Firestore unavailable, using backup:', e.message);
  }

  try {
    return res.json(loadBackupConfig());
  } catch (e) {
    console.error('[api/live-config] Backup load failed:', e.message);
    return res.json({});
  }
};
