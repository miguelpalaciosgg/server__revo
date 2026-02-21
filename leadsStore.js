const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "leads.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]", "utf-8");
}

function load() {
  ensureFile();
  try {
    const raw = fs.readFileSync(FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function save(leads) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(leads, null, 2), "utf-8");
}

function findIndexByKey(leads, { email, phone }) {
  if (email) {
    const e = String(email).toLowerCase();
    const i = leads.findIndex((l) => l.email && l.email.toLowerCase() === e);
    if (i >= 0) return i;
  }
  if (phone) {
    const p = String(phone);
    const i = leads.findIndex((l) => l.phone === p);
    if (i >= 0) return i;
  }
  return -1;
}

function upsertLead({ email, phone, name, lang, channel, tags = [], message, marketingConsent }) {
  if (!email && !phone) return null; // necesitamos al menos una clave
  const leads = load();
  const idx = findIndexByKey(leads, { email, phone });
  const now = new Date().toISOString();

  const interaction = {
    at: now,
    channel,
    tags,
    message,
  };

  if (idx >= 0) {
    const cur = leads[idx];
    leads[idx] = {
      ...cur,
      name: name || cur.name,
      email: email || cur.email,
      phone: phone || cur.phone,
      lang: lang || cur.lang,
      channel: channel || cur.channel,
      marketingConsent:
        typeof marketingConsent === "boolean" ? marketingConsent : cur.marketingConsent,
      lastMessageAt: now,
      interactions: [...(cur.interactions || []), interaction].slice(-100),
    };
  } else {
    const id = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    leads.push({
      id,
      createdAt: now,
      lastMessageAt: now,
      name: name || null,
      email: email || null,
      phone: phone || null,
      lang: lang || null,
      channel: channel || null,
      marketingConsent: typeof marketingConsent === "boolean" ? marketingConsent : false,
      interactions: [interaction],
    });
  }

  save(leads);
  return true;
}

function getLeads() {
  return load();
}

function leadsToCSV(leads) {
  const header = [
    "id",
    "createdAt",
    "lastMessageAt",
    "name",
    "email",
    "phone",
    "lang",
    "channel",
    "marketingConsent",
    "lastTags",
    "lastMessage",
  ].join(",");
  const rows = leads.map((l) => {
    const last = (l.interactions || []).slice(-1)[0] || {};
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    return [
      esc(l.id),
      esc(l.createdAt),
      esc(l.lastMessageAt),
      esc(l.name),
      esc(l.email),
      esc(l.phone),
      esc(l.lang),
      esc(l.channel),
      esc(l.marketingConsent),
      esc((last.tags || []).join("|")),
      esc(last.message || ""),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

module.exports = {
  upsertLead,
  getLeads,
  leadsToCSV,
  ensureFile, // por si quieres inicializar explícitamente
};
