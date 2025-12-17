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


/* ========= UTIL ========= */
function normalize(str) {
  const s = (str ?? "").toString();
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}


function stripGreeting(answer = "") {
  const a = answer.trim();
  const patterns = [
    /^\s*(hola+|buenas+|buenos dias|buenas tardes|buenas noches)[\s,!.:-]*/iu,
    /^\s*(hello+|hi+|hey+|good\s+(morning|afternoon|evening))[\s,!.:-]*/iu
  ];
  let out = a;
  for (const p of patterns) {
    out = out.replace(p, "").trim();
  }
  return out || a;
}


/* ========= FAQs ========= */
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));
const faqsEN = JSON.parse(fs.readFileSync("./faqs.en.json", "utf-8"));


/* ========= OPENAI ========= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


async function aiReply(messages) {
  const r = await openai.chat.completions.create({
    // Recomendado: gpt-4o-mini para coste/latencia; mantener compatibilidad si 3.5 está disponible
    model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
    temperature: 0.2,
    messages
  });
  return r.choices?.[0]?.message?.content || "";
}


/* ========= PROMPT SIMPLE ========= */
function systemPrompt(activity, activityInfo, lang, contact, reserveUrl) {
  let facts = "";
  if (activityInfo) {
    const horariosStr = Array.isArray(activityInfo.horarios || activityInfo.schedule)
      ? (activityInfo.horarios || activityInfo.schedule).join(", ")
      : (activityInfo.horarios || activityInfo.schedule);
    const activityPlaceHints = lang === 'en' ? {
      "Try Dive": "Benidorm Island",
      "Guided Dives": "Benidorm Island"
    } : {
      "Bautismo": "Isla de Benidorm",
      "Inmersiones guiadas": "Isla de Benidorm"
    };
    const actName = activityInfo.nombre || activityInfo.name;
    const lugar = activityPlaceHints[actName] || (lang === 'en' ? (faqsEN.location || 'Benidorm') : (faqsES.ubicacion || 'Benidorm'));
    const precio = activityInfo.precio || activityInfo.price;
    const requisitos = activityInfo.requisitos || activityInfo.requirements;
    facts = lang === 'en'
      ? `Facts: name=${actName}; price=${precio}; requirements=${requisitos}; schedule=${horariosStr}; location=${lugar}; contact=${contact?.phone || ''} ${contact?.email || ''}; booking=${reserveUrl}`
      : `Datos: nombre=${actName}; precio=${precio}; requisitos=${requisitos}; horarios=${horariosStr}; lugar=${lugar}; contacto=${contact?.telefono || contact?.phone || ''} ${contact?.email || ''}; reserva=${reserveUrl}`;
  }
  if (lang === 'en') {
    return `
You are a commercial assistant for a dive center (information and bookings).
Be brief, friendly, and ask at most ONE question per reply.
Include a short, warm greeting only in your first answer; do not repeat greetings. Avoid emojis unless the user uses them.
If the activity is already clear (${activity || 'not defined'}), do not repeat it; move to the next slot.
Slots: level -> activity -> date -> booking/contact.
If the user has no experience, recommend a Try Dive; its price is discounted from the Open Water course if they continue.
CRITICAL: Never confirm bookings or guarantee availability. Direct the user to complete the booking at ${reserveUrl} or by calling ${contact?.phone}. You may offer to collect name and contact for follow-up, but clarify booking is completed via the link or phone.
${facts}
`;
  }
  return `
Eres un asistente comercial de un centro de buceo (información y reservas).
Responde breve, cercano y realiza como máximo UNA pregunta por turno.
Incluye un saludo breve y cálido solo en la primera respuesta; después no repitas saludos. Evita emojis salvo que el usuario los use.
Si la actividad ya está clara (${activity || "no definida"}), no la repitas; avanza al siguiente slot.
Slots: nivel -> actividad -> fecha -> reserva/contacto.
Si el usuario no tiene experiencia, recomienda Bautismo y comenta que su precio se descuenta del Open Water si continúa.
MUY IMPORTANTE: Nunca confirmes reservas ni garantices disponibilidad. Indica que la reserva se completa en ${reserveUrl} o llamando al ${contact?.telefono || contact?.phone}. Puedes recoger nombre y contacto para seguimiento, pero aclara que la reserva se cierra por web o teléfono.
${facts}
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
      contact: null,
      history: [], // [{role:"user"|"assistant", content:string}]
      greeted: false
    };
  }


  const s = sessions[sessionId];
  const text = normalize(userMessage);


  // Detectar idioma (heurística simple por palabras clave)
  if (!s.lang) {
    const enHints = ["hello", "hi", "hey", "book", "price", "when", "where", "email", "phone", "try dive", "guided dives", "snorkel", "snorkeling"];
    const esHints = ["hola", "reserv", "precio", "cuando", "donde", "correo", "telefono", "bautismo", "inmersion", "inmersiones", "snorkel"];
    const score = (arr) => arr.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    s.lang = score(enHints) > score(esHints) ? 'en' : 'es';
  }
  const lang = s.lang;
  const faqs = lang === 'en' ? faqsEN : faqsES;


  /* --- detectar actividad --- */
  if (!s.activity) {
    const hints = lang === 'en'
      ? ["try dive", "discover scuba", "first dive"]
      : ["bautizo", "bautismo", "bauti", "primer buceo", "descubrir buceo"];
    if (hints.some(h => text.includes(h))) s.activity = lang === 'en' ? "Try Dive" : "Bautismo";
    const diveHints = lang === 'en'
      ? ["guided", "guided dives", "fun dive", "dives"]
      : ["inmersion", "inmersiones", "guiadas", "salidas", "fun dive"];
    if (diveHints.some(h => text.includes(h))) s.activity = s.activity || (lang === 'en' ? "Guided Dives" : "Inmersiones guiadas");
    const owHints = ["open water", lang === 'en' ? "entry level" : "curso inicial", lang === 'en' ? "beginner course" : "iniciacion"];
    if (owHints.some(h => text.includes(h))) s.activity = s.activity || "Open Water";
  }


  const activities = lang === 'en' ? (faqs.activities || []) : (faqs.actividades || []);
  const activityInfo = activities.find(a => normalize(a.nombre || a.name) === normalize(s.activity));


  /* --- pasar a reserva --- */
  const wantsToReserve = (lang === 'en')
    ? (text.includes("book") || text.includes("reservation"))
    : text.includes("reserv");
  if (wantsToReserve && s.step === "INFO") {
    s.step = "ASK_NAME";
    return res.json({ answer: lang === 'en' ? "Great! What's your name?" : "Perfecto 😊 ¿Cuál es tu nombre?" });
  }


  /* --- pedir nombre --- */
  if (s.step === "ASK_NAME") {
    if (userMessage.length < 2) {
      return res.json({ answer: lang === 'en' ? "Please tell me your name" : "¿Me dices tu nombre, por favor?" });
    }
    s.name = userMessage.trim();
    s.step = "ASK_CONTACT";
    return res.json({ answer: lang === 'en' ? `Thanks, ${s.name}. Could you share a phone or email?` : `Gracias ${s.name}. ¿Me dejas un teléfono o email?` });
  }


  /* --- pedir contacto --- */
  if (s.step === "ASK_CONTACT") {
    s.contact = userMessage.trim();
    s.step = "DONE";


    const reserveUrl = "https://revolutiondive.com/paga-aqui/";
    const contact = faqs.contacto || faqs.contact || {};
    const msg = lang === 'en'
      ? `Perfect! 🤿 We registered your interest in ${s.activity}. To complete the booking, please go to ${reserveUrl} or call ${contact.phone || contact.telefono}. We will also follow up shortly.`
      : `¡Perfecto! 🤿 Hemos registrado tu interés en ${s.activity}. Para completar la reserva, entra en ${reserveUrl} o llama al ${contact.telefono || contact.phone}. También te contactaremos en breve.`;


    return res.json({ answer: msg });
  }


  /* --- modo IA SOLO PARA INFO --- */
  const reserveUrl = "https://revolutiondive.com/paga-aqui/";
  const contact = faqs.contacto || faqs.contact || {};
  const system = { role: "system", content: systemPrompt(s.activity, activityInfo, lang, contact, reserveUrl) };
  const limitedHistory = s.history.slice(-8); // últimas 8 interacciones aprox
  const messages = [system, ...limitedHistory, { role: "user", content: userMessage }];
  let answer = "";
  try {
    const raw = await aiReply(messages);
    // Permitir un saludo agradable solo en la primera respuesta
    if (!s.greeted) {
      // Si el modelo no saludó, añadimos un saludo breve
      const trimmed = raw.trim();
      const hasGreeting = /^(hola|buenas|bienvenido|encantado|gracias|hello|hi|hey|welcome)/i.test(trimmed);
      answer = hasGreeting ? trimmed : (lang === 'en' ? `Happy to help! ${trimmed}` : `¡Encantado de ayudarte! ${trimmed}`);
    } else {
      answer = stripGreeting(raw);
    }
  } catch (err) {
    const precio = activityInfo?.precio || activityInfo?.price || '';
    const requisitos = activityInfo?.requisitos || activityInfo?.requirements || '';
    const desc = activityInfo?.descripcion || activityInfo?.description || '';
    const fallback = activityInfo
      ? (lang === 'en' ? `${desc}. Price: ${precio}. Requirements: ${requisitos}. Would you like to check dates and availability?` : `${desc}. Precio: ${precio}. Requisitos: ${requisitos}. ¿Quieres que miremos fecha y disponibilidad?`)
      : (lang === 'en' ? `I can help with Try Dives, courses (Open Water, Advanced), guided dives and bookings. What are you interested in?` : `Puedo ayudarte con Bautismo, cursos (Open Water, Advanced), inmersiones guiadas y reservas. ¿Qué te interesa?`);
    answer = fallback;
  }


  // Persistir en la historia
  s.history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: answer }
  );
  if (!s.greeted) s.greeted = true;
  if (s.history.length > 20) {
    s.history.splice(0, s.history.length - 20);
  }


  res.json({ answer });
});


/* ========= ARRANQUE ========= */
app.listen(process.env.PORT || 3001, () =>
  console.log("Assistant running")
);


/* ========= HEALTH ========= */
app.get("/healthz", (req, res) => res.status(200).send("ok"));




