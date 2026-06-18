const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function parseServiceAccount(raw) {
  if (!raw) return null;
  const serviceAccount = JSON.parse(raw);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  return serviceAccount;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.firestore();

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return admin.firestore();
  }

  const candidates = [
    path.resolve(process.cwd(), 'serviceAccountKey.json'),
    path.resolve(process.cwd(), 'f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json'),
    path.resolve(process.cwd(), 'f1watchparty-web-main/f1watchparty-web-main/f1-stream-live-firebase-adminsdk-fbsvc-17b6e466e3.json')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const serviceAccount = require(candidate);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      return admin.firestore();
    }
  }

  throw new Error('Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT.');
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch (error) {
    return {};
  }
}

function setCors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = {
  admin,
  initFirebaseAdmin,
  parseBody,
  setCors
};
