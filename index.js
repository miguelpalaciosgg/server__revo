const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");

// Twilio
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // whatsapp:+14155238886
const TWILIO_CALL_FROM = process.env.TWILIO_CALL_FROM;
let twilio = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  try {
    twilio = require("twilio")(TWILIO_SID, TWILIO_TOKEN);
  } catch (e) {
    console.warn("Twilio init failed:", e.message);
  }
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/* ========= MEMORIA ========= */
const sessions = {};

/* ========= UTIL ========= */
function normalize(str) {
  return (str ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function stripGreeting(answer = "") {
  let out = answer.trim();
  out = out.replace(/^[¡!¿?"']+/u, "");
  out = out.replace(/^(hola|hello|hi|hey|buenas)[\s,!.:-]*/iu, "");
  return out.trim() || answer;
}

function validatePhone(v) {
  if (!v) return null;
  const s = v.toString().replace(/[^\d+]/g, "");
  if (/^\+\d{7,15}$/.test(s)) return s;
  if (/^\d{9}$/.test(s)) return `+34${s}`;
  return null;
}

async function sendWhatsApp(to, body) {
  if (!twilio) throw new Error("Twilio not configured");
  return twilio.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${to}`,
    body,
  });
}

/* ========= FAQs ========= */
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));
const faqsEN = JSON.parse(fs.readFileSync("./faqs.en.json", "utf-8"));

/* ========= OPENAI ========= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function aiReply(messages) {
  const r = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
    temperature: 0.2,
    messages,
  });
  return r.choices?.[0]?.message?.content || "";
}

/* ========= CHAT ========= */
app.post("/chat", async (req, res) => {
  const { userMessage, sessionId = "default" } = req.body;
  if (!userMessage) return res.json({ answer: "¿En qué puedo ayudarte?" });
  const answer = await processMessage(userMessage, sessionId);
  res.json({ answer });
});

// Reusable processor for incoming messages (used by /chat and the webhook)
async function processMessage(userMessage, sessionId = "default") {
  if (!userMessage) return "¿En qué puedo ayudarte?";

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      history: [],
      greeted: false,
      lang: null,
    };
  }

  const s = sessions[sessionId];
  const text = normalize(userMessage);

  if (!s.lang) {
    s.lang = /hello|hi|price|book/.test(text) ? "en" : "es";
  }

  const faqs = s.lang === "en" ? faqsEN : faqsES;
  const reserveUrl = faqs.booking_url || "https://revolutiondive.com/paga-aqui/";
  const faqsText = JSON.stringify(faqs, null, 2);
  const system = {
    role: "system",
    content:
      s.lang === "en"
        ? `You are a concise commercial assistant for a dive center. Use the JSON below strictly as background knowledge; DO NOT print the JSON verbatim. When replying, follow these rules:\n- Answer the user's question directly and helpfully in up to 3 short sentences (be concise).\n- Ask one short clarification question if needed (one sentence).\n- Include one short sentence stating you are an AI assistant (e.g. "I am an AI assistant.").\n- If the user asks about booking, availability, or prices, include a single short line redirecting them to the booking page: ${reserveUrl}.\n- Never confirm a booking or accept payments; always redirect to the booking URL for payments.\nBe friendly, accurate, and brief.\n\nDIVE_CENTER_KNOWLEDGE (use but do not echo):\n${faqsText}`
        : `Eres un asistente comercial conciso para un centro de buceo. Usa el JSON abajo únicamente como base de conocimiento; NO lo imprimas textualmente. Al responder, sigue estas reglas:\n- Responde la pregunta del usuario de forma directa y útil en un máximo de 3 frases cortas (sé conciso).\n- Haz una única pregunta corta de aclaración si hace falta (una frase).\n- Incluye una frase corta indicando que eres una IA (por ejemplo: "Soy una IA asistente.").\n- Si el usuario pregunta por reservas, disponibilidad o precios, añade una línea corta que redirija a la web de reservas: ${reserveUrl}.\n- Nunca confirmes reservas ni aceptes pagos; siempre deriva a la URL de reserva para pagos.\nSé amable, preciso y breve.\n\nCONOCIMIENTO_CENTRO (usar, no mostrar):\n${faqsText}`,
  };

  const messages = [system, ...s.history.slice(-6), { role: "user", content: userMessage }];

  let answer = "";
  try {
    const raw = await aiReply(messages);
    const body = stripGreeting(raw);
    if (!s.greeted) {
      answer = s.lang === "en" ? `Hi! ${body}` : `¡Hola! ${body}`;
      s.greeted = true;
    } else {
      answer = body;
    }
  } catch (err) {
    answer = s.lang === "en" ? "I can help with dives, courses and bookings." : "Puedo ayudarte con inmersiones, cursos y reservas.";
  }

  s.history.push({ role: "user", content: userMessage }, { role: "assistant", content: answer });
  if (s.history.length > 20) s.history.shift();

  return answer;
}

/* ========= 🔥 WEBHOOK WHATSAPP (LO NUEVO) ========= */
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const incoming = req.body.Body;
    const from = req.body.From?.replace("whatsapp:", "");
    if (!incoming || !from) {
      return res.type("text/xml").send("<Response/>");
    }

    const sessionId = `wa-${from}`;

    // Process the message locally instead of fetching the public URL
    const answer = (await processMessage(incoming, sessionId)) || "Gracias por tu mensaje 🙂";

    res.type("text/xml").send(`
      <Response>
        <Message>${answer}</Message>
      </Response>
    `);
  } catch (err) {
    console.error("WhatsApp webhook error:", err.message);
    res.type("text/xml").send(`
      <Response>
        <Message>Error temporal. Inténtalo de nuevo.</Message>
      </Response>
    `);
  }
});

/* ========= ARRANQUE ========= */
app.listen(process.env.PORT || 3001, () =>
  console.log("Assistant running")
);

/* ========= HEALTH ========= */
app.get("/healthz", (req, res) => res.send("ok"));
