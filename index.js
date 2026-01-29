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

  // If this is the first reply in the session, send a short greeting with the booking link
  // and an explicit AI notice, then mark the session as greeted. Subsequent replies
  // will use the AI normally and will NOT include the greeting/link automatically.
  if (!s.greeted) {
    s.greeted = true;
    const reserveLine = s.lang === "en" ? `Booking: ${reserveUrl}` : `Reservas: ${reserveUrl}`;
    const aiLine = s.lang === "en" ? `I am an AI assistant.` : `Soy una IA asistente.`;
    const helpLine = s.lang === "en" ? `How can I help you?` : `¿En qué puedo ayudarle?`;

    const greeting = s.lang === "en"
      ? `Hi! ${aiLine} ${reserveLine}\n\n${helpLine}`
      : `¡Hola! ${aiLine} ${reserveLine}\n\n${helpLine}`;

    // record conversation turn (user message + assistant greeting)
    s.history.push({ role: "user", content: userMessage }, { role: "assistant", content: greeting });
    if (s.history.length > 40) s.history.splice(0, s.history.length - 40);
    return greeting;
  }
  const faqsText = JSON.stringify(faqs, null, 2);
  // Localized Benidorm island info used as background knowledge (do not echo verbatim)
  const benidormInfo = s.lang === "en"
    ? `Benidorm Island is a popular local dive spot with generally good visibility. Typical sightings include moray eels, octopus, groupers, colorful nudibranchs, damselfish and varied rocky reef communities with gorgonians and small schools of fish.`
    : `La isla de Benidorm es un lugar de buceo popular con buena visibilidad. Es habitual ver morenas, pulpos, meros, nudibranquios coloridos, peces damisela y comunidades de arrecife rocoso con gorgonias y pequeños bancos de peces.`;
  const system = {
    role: "system",
    content:
      s.lang === "en"
        ? `Act as an expert and friendly diving center assistant. Your goal is to provide information about courses and introductory dives based EXCLUSIVELY on the context provided below.

      Special rule: If the user asks what can be seen underwater around Benidorm Island or about marine life there, include a short (1-2 sentence) natural description mentioning typical species and that the island is an excellent spot with good visibility. Use BENIDORM_INFO as background (do not print it verbatim unless asked).

Behavior Rules:
1. DATA-DRIVEN: Use only the information from CENTER_KNOWLEDGE. If the answer is not there, kindly state that you don't have that information and suggest contacting human staff.
2. CONCISENESS: Be brief and direct, but ensure you answer the full question. Do not use unnecessary commercial filler.
3. BOOKINGS: Never confirm a booking. If explicitly asked to book, provide the link. If not explicitly asked, DO NOT provide the link.
4. IDENTITY: Always end your response with a very brief signature in parentheses (e.g., "(AI Assistant)").

CENTER_KNOWLEDGE:
${faqsText}

BENIDORM_INFO:
${benidormInfo}`
        : `Actúa como un asistente experto y amable del centro de buceo. Tu objetivo es informar sobre cursos y bautizos basándote EXCLUSIVAMENTE en el contexto proporcionado abajo.

Reglas de comportamiento:
1. BASADO EN DATOS: Usa solo la información del CONOCIMIENTO_CENTRO. Si la respuesta no está ahí, di amablemente que no tienes esa información y sugiere que contacten al personal humano.
2. CONCISIÓN: Sé breve y directo, pero asegúrate de responder la duda completa. No uses relleno comercial innecesario.
3. RESERVAS: Nunca confirmes una reserva. Si te piden reservar explícitamente, facilita el enlace. Si no te lo piden, NO pongas el enlace.
4. COMPORTAMIENTO: No preguntes nada al responder a algo, puedes en su lugar decir si necesitas otra cosa me dices, o cualquier otra pregunta puedes hacerme, cosas así.

CONOCIMIENTO_CENTRO:
${faqsText}

INFO_BENIDORM:
${benidormInfo}`,
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
