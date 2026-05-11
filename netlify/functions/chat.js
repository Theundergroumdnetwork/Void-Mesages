const crypto = require("crypto");

const ONLINE_WINDOW_MS = 20000;
const MAX_INBOX_MESSAGES = 250;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(204, "");
  if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed" });

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Bad JSON" });
  }

  const { getStore } = await import("@netlify/blobs");
  const store = getStore("void-chat");
  const now = Date.now();
  const profile = data.profile || {};
  const id = cleanId(profile.id || data.id);
  const clientToken = cleanToken(data.clientToken);

  if (data.type === "offline") {
    if (id && clientToken) await store.delete(presenceKey(id, clientToken));
    return response(200, { ok: true, now });
  }

  if (!id || !clientToken) return response(400, { error: "Missing profile" });

  await store.setJSON(presenceKey(id, clientToken), {
    id,
    name: String(profile.name || id).slice(0, 80),
    touched: now
  });

  if (data.type === "message") {
    await saveMessage(store, id, data);
  }

  const friends = (data.friends || []).map(cleanId).filter(Boolean);
  const online = await onlineFriends(store, friends, now);
  const messages = await inboxMessages(store, id, Number(data.since || 0));

  return response(200, {
    type: "presence",
    online,
    messages,
    now
  });
};

async function saveMessage(store, from, data) {
  const to = cleanId(data.to);
  const incoming = data.message || {};
  const text = String(incoming.text || "").slice(0, 8000);
  if (!to || !text) return;

  const message = {
    id: String(incoming.id || crypto.randomUUID()),
    from,
    text,
    time: Number(incoming.time || Date.now())
  };

  const key = inboxKey(to);
  const inbox = (await store.get(key, { type: "json" })) || [];
  if (!inbox.some((item) => item.id === message.id)) inbox.push(message);
  await store.setJSON(key, inbox.slice(-MAX_INBOX_MESSAGES));
}

async function onlineFriends(store, friends, now) {
  const result = [];
  const presence = await store.list({ prefix: "presence/" });
  const friendSet = new Set(friends);
  const seen = new Set();

  for (const blob of presence.blobs || []) {
    const parts = blob.key.split("/");
    const id = parts[1];
    if (!friendSet.has(id)) continue;

    const entry = await store.get(blob.key, { type: "json" });
    if (!entry || now - Number(entry.touched || 0) > ONLINE_WINDOW_MS) {
      await store.delete(blob.key);
      continue;
    }

    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

async function inboxMessages(store, id, since) {
  const inbox = (await store.get(inboxKey(id), { type: "json" })) || [];
  return inbox.filter((message) => Number(message.time || 0) > since);
}

function cleanId(value) {
  const id = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9_-]{2,40}$/.test(id) ? id : "";
}

function cleanToken(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function presenceKey(id, token) {
  return `presence/${id}/${token}`;
}

function inboxKey(id) {
  return `inbox/${id}`;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
