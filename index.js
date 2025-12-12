const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");

const app = express();

// --- CORS ---
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); // permitir curl/Invoke-RestMethod
    console.log("CORS origin:", origin, "allowed:", allowed);
    if (allowed.includes(origin)) return cb(null, true);
    cb(new Error("CORS blocked: " + origin));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Preflight global
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.sendStatus(204);
  }
  next();
});

// Body parser
app.use(bodyParser.json());

// --- FAQs ---
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));
const faqsEN = JSON.parse(fs.readFileSync("./faqs.en.json", "utf-8"));

function systemPrompt(lang, faqs) {
  // Convertimos los FAQs a un texto resumido
  const faqsText = `
Actividades disponibles:
${faqs.actividades.map(a => `- ${a.nombre}: ${a.descripcion} (Precio: ${a.precio}, Requisitos: ${a.requisitos || 'No especificado'}, Horarios: ${a.horarios.join(', ')})`).join('\n')}
Ubicación: ${faqs.ubicacion}
Horarios generales: ${faqs.horarios_generales.Benidorm}
Reservas: ${faqs.reservas.politica}. Contacto: ${faqs.contacto.email}, ${faqs.contacto.telefono}
  `;

  const base = lang === "es"
    ? `Eres el asistente del centro de buceo Revolution Dive en Benidorm. Tu objetivo es cualificar leads para actividades de buceo. Usa solo la información de FAQs que se indica a continuación. Sé breve y claro. Pide consentimiento para guardar nombre, email/teléfono, idioma, actividad, fechas y nivel. No inventes información.
${faqsText}`
    : `You are the dive center assistant for Revolution Dive in Benidorm. Your goal is to qualify leads for diving activities. Use only the FAQ information provided below. Be brief and clear. Ask consent before collecting name, email/phone, language, activity, dates, and level. Do not invent information.
${faqsText}`;

  return base + ` Idioma=${lang}.`;
}

// --- OpenAI v6.x ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function ollamaChat(messages) {
  try {
    const chatMessages = messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    const response = await openai.chat.completions.create({
      model: process.env.OLLAMA_MODEL || "gpt-3.5-turbo",
      messages: chatMessages,
      temperature: 0.3,
    });

    const answer = response.choices[0].message.content || "";
    console.log("Respuesta IA:", answer);
    return answer;

  } catch (err) {
    console.error("Error OpenAI:", err.response?.status, err.response?.data || err);
    return "Error: no se pudo obtener respuesta de la IA";
  }
}

// --- Rutas ---
app.post("/chat", async (req, res) => {
  try {
    console.log("Petición /chat recibida:", req.body);

    const { userMessage, lang = "es" } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: "userMessage required" });

    const kb = lang === "en" ? faqsEN : faqsES;
    const messages = [
      { role: "system", content: systemPrompt(lang,kb) },
      { role: "system", content: "FAQs:\n" + JSON.stringify(kb).slice(0, 16000) },
      { role: "user", content: userMessage }
    ];

    const answer = await ollamaChat(messages);
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.json({ answer });

  } catch (e) {
    console.error("chat_error:", e);
    res.status(500).json({ error: "chat_error", detail: String(e) });
  }
});

app.post("/leads", (req, res) => {
  try {
    const { name, contact, lang = "es", activity, dates, level, consent } = req.body || {};
    if (!consent) return res.status(400).json({ error: "consent_required" });

    const entry = { ts: new Date().toISOString(), name, contact, lang, activity, dates, level, consent: !!consent };
    const path = "./leads.json";
    let arr = [];
    if (fs.existsSync(path)) arr = JSON.parse(fs.readFileSync(path, "utf-8"));
    arr.push(entry);
    fs.writeFileSync(path, JSON.stringify(arr, null, 2));

    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.json({ ok: true });

  } catch (e) {
    console.error("lead_error:", e);
    res.status(500).json({ error: "lead_error", detail: String(e) });
  }
});

// --- Arranque ---
const port = process.env.PORT || 3001;
app.listen(port, () => console.log("Assistant API on :" + port));
console.log("OPENAI_API_KEY:", !!process.env.OPENAI_API_KEY);
