const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");

const app = express();

/* =========================
   MEMORIA DE SESIONES (RAM)
========================= */
const sessions = {};

/* =========================
   CORS
========================= */
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

/* =========================
   FAQs
========================= */
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));
const faqsEN = JSON.parse(fs.readFileSync("./faqs.en.json", "utf-8"));

/* =========================
   SYSTEM PROMPT
========================= */
function systemPrompt(lang, faqs, memory) {
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

  const memoryText = memory.activity
    ? `Actividad ya seleccionada por el cliente: ${memory.activity}.
No vuelvas a preguntar por la actividad.`
    : `Actividad aún no seleccionada.`;

  const baseES = `
Eres el asistente comercial del centro de buceo Revolution Dive en Benidorm.
Tu objetivo es ayudar a los clientes y convertir conversaciones en reservas.
Usa SOLO la información proporcionada.
No inventes información.
Sé cercano, claro y profesional.
No repitas saludos innecesarios.
Guía al cliente paso a paso.
Si el cliente confirma que quiere reservar una actividad, pasarle nuestro whatsapp, si se puede el enlace directo para hablar. 

${memoryText}

${faqsText}
`;

  const baseEN = `
You are the sales assistant for Revolution Dive in Benidorm.
Your goal is to help customers and convert conversations into bookings.
Use ONLY the provided information.
Be clear, friendly and professional.

${memoryText}

${faqsText}
`;

  return lang === "en" ? baseEN : baseES;
}

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function openaiChat(messages) {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
    messages,
    temperature: 0.3
  });

  return response.choices[0]?.message?.content || "";
}

/* =========================
   /CHAT
========================= */
app.post("/chat", async (req, res) => {
  try {
    const { userMessage, lang = "es", sessionId } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: "userMessage required" });

    const sid = sessionId || "default";

    if (!sessions[sid]) {
      sessions[sid] = {
        activity: null,
        step: "INIT", // INIT | ASK_NAME | ASK_CONTACT | DONE
        name: null,
        contact: null
      };
    }

    const memory = sessions[sid];
    const text = userMessage.toLowerCase();

    /* =========================
       DETECCIÓN DE ACTIVIDAD
    ========================= */
    if (!memory.activity) {
      if (text.includes("bautizo") || text.includes("try dive")) {
        memory.activity = "Try Dive";
      }
      if (text.includes("open water")) {
        memory.activity = "Open Water";
      }
    }

    /* =========================
       DETECCIÓN DE RESERVA
    ========================= */
    if (
      (text.includes("reservar") || text.includes("quiero reservar")) &&
      memory.step === "INIT"
    ) {
      memory.step = "ASK_NAME";
    }

    /* =========================
       FLUJO GUIADO
    ========================= */
    if (memory.step === "ASK_NAME") {
      if (!memory.name && userMessage.trim().split(" ").length >= 2) {
        memory.name = userMessage.trim();
        memory.step = "ASK_CONTACT";

        return res.json({
          answer: `¡Gracias, ${memory.name}! 😊  
¿Podrías facilitarme un email o número de teléfono para continuar con la reserva?`
        });
      }

      return res.json({
        answer: "Perfecto 😊 ¿Me indicas tu nombre completo para continuar con la reserva?"
      });
    }

    if (memory.step === "ASK_CONTACT") {
      memory.contact = userMessage.trim();
      memory.step = "DONE";

      return res.json({
        answer: `¡Genial! 🤿  
Hemos registrado tu interés en el **${memory.activity}**.

En breve nuestro equipo se pondrá en contacto contigo para finalizar la reserva.  
¡Gracias por confiar en Revolution Dive!`
      });
    }

    /* =========================
       OPENAI RESPUESTA NORMAL
    ========================= */
    const kb = lang === "en" ? faqsEN : faqsES;

    const messages = [
      {
        role: "system",
        content: systemPrompt(lang, kb, memory)
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

/* =========================
   /LEADS (opcional)
========================= */
app.post("/leads", (req, res) => {
  try {
    const { name, contact, activity, consent } = req.body || {};
    if (!consent) return res.status(400).json({ error: "consent_required" });

    const entry = {
      ts: new Date().toISOString(),
      name,
      contact,
      activity
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

/* =========================
   ARRANQUE
========================= */
const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log("Assistant API running on port", port);
});
