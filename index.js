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
function normalize(str = "") {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}


function stripGreeting(answer = "") {
  const a = answer.trim();
  const patterns = [
    /^\s*(hola+|buenas+|buenos dias|buenas tardes|buenas noches)[\s,!.:-]*/iu
  ];
  let out = a;
  for (const p of patterns) {
    out = out.replace(p, "").trim();
  }
  return out || a;
}


/* ========= FAQs ========= */
const faqsES = JSON.parse(fs.readFileSync("./faqs.es.json", "utf-8"));


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
function systemPrompt(activity, activityInfo) {
  let facts = "";
  if (activityInfo) {
    const horariosStr = Array.isArray(activityInfo.horarios)
      ? activityInfo.horarios.join(", ")
      : activityInfo.horarios;
    facts = `Datos actividad: nombre=${activityInfo.nombre}; precio=${activityInfo.precio}; requisitos=${activityInfo.requisitos}; horarios=${horariosStr}`;
  }
  return `
Eres un asistente comercial de un centro de buceo, especializado en información y reservas.
Responde breve, directo, y realiza como máximo UNA pregunta por turno.
No incluyas saludos (no empieces con Hola/Buenas) y evita emojis salvo que el usuario los use.
Si la actividad ya está clara (${activity || "no definida"}), no la repitas; avanza al siguiente slot.
Slots: nivel -> actividad -> fecha -> reserva/contacto.
Si el usuario no tiene experiencia, recomienda Bautismo y comenta que su precio se descuenta del Open Water si continúa.
Cuando el usuario muestre interés en reservar, pide nombre y contacto (teléfono o email) de forma natural.
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
      history: [] // [{role:"user"|"assistant", content:string}]
    };
  }


  const s = sessions[sessionId];
  const text = normalize(userMessage);


  /* --- detectar actividad --- */
  if (!s.activity) {
    const hints = ["bautizo", "bautismo", "try dive", "bauti", "primer buceo", "descubrir buceo"];
    if (hints.some(h => text.includes(h))) s.activity = "Bautismo";
    const diveHints = ["inmersion", "inmersiones", "guiadas", "fun dive", "salidas"];
    if (diveHints.some(h => text.includes(h))) s.activity = s.activity || "Inmersiones guiadas";
    const owHints = ["open water", "curso inicial", "iniciacion"];
    if (owHints.some(h => text.includes(h))) s.activity = s.activity || "Open Water";
  }


  const activityInfo = faqsES.actividades.find(a => normalize(a.nombre) === normalize(s.activity));


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
  const system = { role: "system", content: systemPrompt(s.activity, activityInfo) };
  const limitedHistory = s.history.slice(-8); // últimas 8 interacciones aprox
  const messages = [system, ...limitedHistory, { role: "user", content: userMessage }];
  let answer = "";
  try {
    const raw = await aiReply(messages);
    answer = stripGreeting(raw);
  } catch (err) {
    const fallback = activityInfo
      ? `${activityInfo.descripcion}. Precio: ${activityInfo.precio}. Requisitos: ${activityInfo.requisitos}. ¿Quieres que miremos fecha y disponibilidad?`
      : "Puedo ayudarte con Bautismo, cursos (Open Water, Advanced), inmersiones guiadas y reservas. ¿Qué te interesa?";
    answer = fallback;
  }


  // Persistir en la historia
  s.history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: answer }
  );
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