const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");

const app = express();

// ==============================
// MEMORIA DE SESIONES (RAM)
// ==============================
const sessions = {}; // { sessionId: { activity: "Try Dive", ... } }

// ==============================
// CORS
// ==============================
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (!allowed.length || allowed.includes(origin)) return cb(null, true);
    cb(new Error("CORS blocked"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// ==============================
// FAQs
// ==============================
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));
const faqsEN = JSON.parse(fs.readFileSync("./faqs.en.json", "utf-8"));

// ==============================
// SYSTEM PROMPT
// ==============================
function systemPrompt(lang, faqs) {
  const actividades = Array.isArray(faqs.actividades) ? faqs.actividades : [];

  const faqsText = `
Actividades disponibles:
${actividades.map(a => `- ${a.nombre}: ${a.descripcion}
  Precio: ${a.precio}
  Requisitos: ${a.requisitos}
  Horarios: ${Array.isArray(a.horarios) ? a.horarios.join(", ") : a.horarios}
`).join("\n")}

Ubicación: ${faqs.ubicacion}
Horarios generales: ${faqs.horarios_generales?.Benidorm}
Política de reservas: ${faqs.reservas?.politica}
Contacto: ${faqs.contacto?.email} | ${faqs.contacto?.telefono}
`;

  const baseES = `
Eres el asistente comercial del centro de buceo Revolution Dive en Benidorm.
Tu objetivo principal es ayudar a los clientes y convertir conversaciones en reservas.
Usa SOLO la información proporcionada a continuación.
No inventes información.
Responde de forma clara, cercana y profesional.
Cuando detectes interés real, invita al cliente a reservar o a dejar sus datos.
Pide consentimiento antes de solicitar o guardar datos personales.
Cuando el usuario pregunte por una actividad concreta (por ejemplo: bautismo, try dive, open water),
considera esa actividad como seleccionada y NO vuelvas a preguntarla,
a menos que el usuario la cambie explícitamente.

${faqsText}
`;

  const baseEN = `
You are the sales assistant for the dive center Revolution Dive in Benidorm.
Your main goal is to help customers and convert conversations into bookings.
Use ONLY the information provided below.
Do not invent information.
Be clear, friendly and professional.
When you detect real interest, guide the user to book or leave contact details.
Ask for consent before requesting or storing personal data.
When the user mentions a specific activity, consider it selected and do not ask again unless changed.

${faqsText}
`;

  return lang === "en" ? baseEN : baseES;
}

// ==============================
// OPENAI
// ==============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function openaiChat(messages) {
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      messages,
      temperature: 0.3
    });

    return response.choices[0]?.message?.content || "";

  } catch (err) {
    console.error("OpenAI error:", err.response?.status || err.message);
    return "Lo siento, ahora mismo no puedo ayudarte. ¿Quieres que te contactemos por WhatsApp?";
  }
}

// ==============================
// RUTA /chat
// ==============================
app.post("/chat", async (req, res) => {
  try {
    const { userMessage, lang = "es", sessionId } = req.body || {};
    if (!userMessage) {
      return res.status(400).json({ error: "userMessage required" });
    }

    const sid = sessionId || "default";

    // inicializar sesión
    if (!sessions[sid]) {
      sessions[sid] = {
        activity: null
      };
    }

    const language = lang === "en" ? "en" : "es";
    const kb = language === "en" ? faqsEN : faqsES;

    // ==============================
    // DETECCIÓN DE ACTIVIDAD
    // ==============================
    const text = userMessage.toLowerCase();

    if (text.includes("bautizo") || text.includes("try dive")) {
      sessions[sid].activity = "Try Dive";
    }

    if (text.includes("open water")) {
      sessions[sid].activity = "Open Water";
    }

    if (text.includes("advanced")) {
      sessions[sid].activity = "Advanced";
    }

    // ==============================
    // MEMORIA PARA EL PROMPT
    // ==============================
    const memoryText = sessions[sid].activity
      ? `Actividad ya seleccionada por el cliente: ${sessions[sid].activity}.
No vuelvas a preguntar por la actividad.`
      : `Actividad aún no seleccionada.`;

    const messages = [
      {
        role: "system",
        content: systemPrompt(language, kb) + "\n\n" + memoryText
      },
      { role: "user", content: userMessage }
    ];

    const answer = await openaiChat(messages);
    res.json({ answer });

  } catch (e) {
    console.error("chat_error:", e);
    res.status(500).json({ error: "chat_error" });
  }
});

// ==============================
// RUTA /leads
// ==============================
app.post("/leads", (req, res) => {
  try {
    const { name, contact, lang = "es", activity, dates, level, consent } = req.body || {};
    if (!consent) return res.status(400).json({ error: "consent_required" });

    const entry = {
      ts: new Date().toISOString(),
      name,
      contact,
      lang,
      activity,
      dates,
      level,
      consent: true
    };

    const path = "./leads.json";
    const arr = fs.existsSync(path)
      ? JSON.parse(fs.readFileSync(path, "utf-8"))
      : [];

    arr.push(entry);
    fs.writeFileSync(path, JSON.stringify(arr, null, 2));

    res.json({ ok: true });

  } catch (e) {
    console.error("lead_error:", e);
    res.status(500).json({ error: "lead_error" });
  }
});

// ==============================
// ARRANQUE
// ==============================
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("Assistant API running on port", port);
});
