const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ========= MEMORIA ========= */
const sessions = {};

/* ========= FAQs ========= */
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));

/* ========= OPENAI ========= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function aiReply(system, user) {
  const r = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return r.choices[0].message.content;
}

/* ========= PROMPT SIMPLE ========= */
function systemPrompt(activity) {
  return `
Eres un asistente comercial de un centro de buceo.
Responde SIEMPRE en menos de 3 frases.
No repitas saludos.
Si la actividad ya está clara (${activity || "no definida"}), no la vuelvas a explicar.
Invita a reservar si el usuario muestra interés.
`;
}

/* ========= CHAT ========= */
app.post("/chat", async (req, res) => {
  const { userMessage, sessionId = "default" } = req.body;
  if (!userMessage) return res.json({ answer: "¿En qué puedo ayudarte?" });

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      activity: null,
      step: "INFO",
      name: null,
      contact: null
    };
  }

  const s = sessions[sessionId];
  const text = userMessage.toLowerCase();

  /* --- detectar actividad --- */
  if (!s.activity && (text.includes("bautizo") || text.includes("try dive"))) {
    s.activity = "Bautismo de buceo (Try Dive)";
  }

  /* --- pasar a reserva --- */
  if (text.includes("reservar") && s.step === "INFO") {
    s.step = "ASK_NAME";
    return res.json({ answer: "Perfecto 😊 ¿Cuál es tu nombre?" });
  }

  /* --- pedir nombre --- */
  if (s.step === "ASK_NAME") {
    if (userMessage.length < 3 || text.includes("reserv")) {
      return res.json({ answer: "¿Me dices tu nombre, por favor?" });
    }
    s.name = userMessage.trim();
    s.step = "ASK_CONTACT";
    return res.json({ answer: `Gracias ${s.name}. ¿Me dejas un teléfono o email?` });
  }

  /* --- pedir contacto --- */
  if (s.step === "ASK_CONTACT") {
    s.contact = userMessage.trim();
    s.step = "DONE";

    return res.json({
      answer: `¡Perfecto! 🤿  
Hemos recibido tu solicitud para el **${s.activity}**.  
Te contactaremos en breve para cerrar la reserva.`
    });
  }

  /* --- modo IA SOLO PARA INFO --- */
  const answer = await aiReply(
    systemPrompt(s.activity),
    userMessage
  );

  res.json({ answer });
});

/* ========= ARRANQUE ========= */
app.listen(process.env.PORT || 3001, () =>
  console.log("Assistant running")
);
