/**
 * src/firebase.js
 * Lightweight Firebase Firestore REST client for Cloudflare Workers.
 * Generates OAuth2 tokens via RS256 JWT using Web Crypto API.
 */

// Helper to convert PEM private key to ArrayBuffer
function pemToArrayBuffer(pem) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");
  const binary = atob(pemContents);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// URL-safe Base64 encoding
function base64UrlEncode(str) {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function arrayBufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return base64UrlEncode(binary);
}

// Generate RS256 JWT
async function generateJWT(clientEmail, privateKeyPem) {
  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const claims = JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp,
    iat
  });

  const encodedHeader = base64UrlEncode(header);
  const encodedClaims = base64UrlEncode(claims);
  const tokenInput = `${encodedHeader}.${encodedClaims}`;

  const privateKeyBuffer = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" }
    },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(tokenInput)
  );

  const encodedSignature = arrayBufferToBase64Url(signatureBuffer);
  return `${tokenInput}.${encodedSignature}`;
}

// Exchange JWT for Access Token
async function getAccessToken(clientEmail, privateKeyPem) {
  const jwt = await generateJWT(clientEmail, privateKeyPem);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth token exchange failed: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Recursively wrap JS object into Firestore REST API fields format
export function wrapFirestore(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(wrapFirestore) } };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const k in val) {
      fields[k] = wrapFirestore(val[k]);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

// Recursively unwrap Firestore REST API fields format
export function unwrapFirestore(val) {
  if (!val || typeof val !== "object") return val;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return parseInt(val.integerValue, 10);
  if ("doubleValue" in val) return parseFloat(val.doubleValue);
  if ("booleanValue" in val) return val.booleanValue;
  if ("nullValue" in val) return null;
  if ("arrayValue" in val) return (val.arrayValue.values || []).map(unwrapFirestore);
  if ("mapValue" in val) {
    const fields = val.mapValue.fields || {};
    const res = {};
    for (const k in fields) {
      res[k] = unwrapFirestore(fields[k]);
    }
    return res;
  }
  return val;
}

// Firestore REST Client
export class FirestoreClient {
  constructor(projectId, clientEmail, privateKeyPem) {
    this.projectId = projectId;
    this.clientEmail = clientEmail;
    this.privateKeyPem = privateKeyPem;
    this.cachedToken = null;
    this.tokenExpiry = 0;
  }

  async getValidToken() {
    if (this.cachedToken && Date.now() < this.tokenExpiry - 60000) {
      return this.cachedToken;
    }
    if (!this.clientEmail || !this.privateKeyPem) {
      throw new Error("FirestoreClient is missing credentials");
    }
    const token = await getAccessToken(this.clientEmail, this.privateKeyPem);
    this.cachedToken = token;
    this.tokenExpiry = Date.now() + 3600 * 1000;
    return token;
  }

  async getConfig(collection = "app_data", document = "live_config") {
    const token = await this.getValidToken();
    const url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${collection}/${document}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) return {};
      const text = await response.text();
      throw new Error(`Firestore getConfig failed: ${text}`);
    }

    const doc = await response.json();
    const fields = doc.fields || {};
    const res = {};
    for (const k in fields) {
      res[k] = unwrapFirestore(fields[k]);
    }
    return res;
  }

  async updateConfig(updateData, collection = "app_data", document = "live_config") {
    const token = await this.getValidToken();
    const updateMaskParams = Object.keys(updateData)
      .map(k => `updateMask.fieldPaths=${k}`)
      .join("&");
    const url = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents/${collection}/${document}?${updateMaskParams}`;

    const fields = {};
    for (const k in updateData) {
      fields[k] = wrapFirestore(updateData[k]);
    }

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Firestore updateConfig failed: ${text}`);
    }

    return await response.json();
  }
}
