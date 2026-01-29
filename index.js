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
        ? `You are a commercial assistant for a dive center. When replying, follow these rules exactly:\n1) Begin with one short sentence instructing the user to make their booking on the website: ${reserveUrl}.\n2) Ask a single short clarification question (one sentence).\n3) State in one short sentence that you are an AI assistant.\n4) Provide all the information you have about the dive center (copy the JSON below exactly).\n5) Do NOT confirm bookings or accept payments; always redirect to the booking URL. Be concise and accurate.\n\nDIVE_CENTER_INFO:\n${faqsText}`
        : `Eres un asistente comercial de un centro de buceo. Al responder, sigue estas reglas exactamente:\n1) Empieza con una frase corta indicando que reserve en la web: ${reserveUrl}.\n2) Haz una única pregunta corta de aclaración (una frase).\n3) Indica en una frase corta que eres una IA.\n4) Proporciona toda la información que tienes sobre el centro de buceo (copia el JSON abajo exactamente).\n5) NO confirmes reservas ni aceptes pagos; siempre deriva a la URL de reserva. Sé conciso y exacto.\n\nINFORMACIÓN_CENTRO:\n${faqsText}`,
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

    // Twilio has a concatenated message limit (~1600 chars). Truncate long replies
    let outAnswer = answer;
    try {
      const maxLen = 1500;
      if (outAnswer && outAnswer.length > maxLen) {
        const s = sessions[sessionId];
        const lang = s?.lang || "es";
        const note = lang === "en" ? "\n\n(Shortened. See booking page for full info.)" : "\n\n(Respuesta resumida. Consulta la web para toda la información.)";
        outAnswer = outAnswer.slice(0, maxLen - note.length) + note;
        console.warn("WhatsApp reply truncated to fit Twilio limit", { originalLength: answer.length, truncatedLength: outAnswer.length, sessionId });
      }
    } catch (e) {
      console.warn("Error while truncating WhatsApp reply:", e?.message || e);
    }

    res.type("text/xml").send(`
      <Response>
        <Message>${outAnswer}</Message>
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
