const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");
const { Pool } = require("pg"); // <-- NUEVO: Librería de base de datos

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ========= CONEXIÓN A BASE DE DATOS ========= */
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

/* ========= UTIL ========= */
function normalize(str) {
  return (str ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function stripGreeting(answer = "") {
  let out = answer.trim();
  out = out.replace(/^[¡!¿?"']+/u, "");
  out = out.replace(/^(hola|hello|hi|hey|buenas)[\s,!.:-]*/iu, "");
  return out.trim() || answer;
}

/* ========= FAQs (Mantenemos los JSON por ahora) ========= */
function safeReadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.warn(`[WARN] Could not read ${filePath}. Continuing with empty data.`);
    return {};
  }
}
const faqsES = safeReadJSON("./faqs.es.json");
const faqsEN = safeReadJSON("./faqs.en.json");

/* ========= OPENAI ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function aiReply(messages) {
  if (!openai) throw new Error("OpenAI not configured");
  const r = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages,
  });
  return r.choices?.[0]?.message?.content || "";
}

/* ========= LÓGICA DEL CHAT ========= */
app.post("/chat", async (req, res) => {
  // Ahora pediremos el número de teléfono o un ID único
  const { userMessage, telefono = "web_anonimo" } = req.body; 
  if (!userMessage) return res.json({ answer: "¿En qué puedo ayudarte?" });
  
  try {
    const answer = await processMessage(userMessage, telefono);
    res.json({ answer });
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    res.status(500).json({ answer: "Lo siento, tuve un problema técnico. ¿Puedes repetirlo?" });
  }
});

async function processMessage(userMessage, telefono) {
  // 1. BUSCAR O CREAR USUARIO EN LA BASE DE DATOS
  let userQuery = await pool.query('SELECT id_usuario FROM usuarios WHERE telefono = $1', [telefono]);
  let idUsuario;
  
  if (userQuery.rows.length === 0) {
    const newUser = await pool.query(
      'INSERT INTO usuarios (telefono) VALUES ($1) RETURNING id_usuario', 
      [telefono]
    );
    idUsuario = newUser.rows[0].id_usuario;
  } else {
    idUsuario = userQuery.rows[0].id_usuario;
  }

  // 2. BUSCAR O CREAR SESIÓN ABIERTA
  let sessionQuery = await pool.query(
    "SELECT id_sesion FROM sesiones_chat WHERE id_usuario = $1 AND estado = 'abierta' ORDER BY fecha_inicio DESC LIMIT 1",
    [idUsuario]
  );
  let idSesion;

  if (sessionQuery.rows.length === 0) {
    const newSession = await pool.query(
      "INSERT INTO sesiones_chat (id_usuario, plataforma) VALUES ($1, 'web') RETURNING id_sesion",
      [idUsuario]
    );
    idSesion = newSession.rows[0].id_sesion;
  } else {
    idSesion = sessionQuery.rows[0].id_sesion;
  }

  // 3. RECUPERAR EL HISTORIAL DE ESA SESIÓN
  const historyQuery = await pool.query(
    'SELECT remitente, contenido FROM mensajes WHERE id_sesion = $1 ORDER BY fecha_hora ASC LIMIT 20',
    [idSesion]
  );
  
  // Transformar de la BD al formato de OpenAI
  const dbHistory = historyQuery.rows.map(row => ({
    role: row.remitente === 'usuario' ? 'user' : 'assistant',
    content: row.contenido
  }));

  // Detectar idioma y armar el sistema (tu lógica original)
  const text = normalize(userMessage);
  const lang = /hello|hi|price|book/.test(text) ? "en" : "es";
  const faqs = lang === "en" ? faqsEN : faqsES;
  const benidormInfo = lang === "en" ? "Benidorm Island is a popular..." : "La isla de Benidorm es...";
  const faqsText = JSON.stringify(faqs, null, 2);

  const systemMessage = {
    role: "system",
    content: `Actúa como un asistente del centro de buceo. Responde brevemente basándote en: \n${faqsText}\nInfo: ${benidormInfo}`
  };

  const messages = [systemMessage, ...dbHistory, { role: "user", content: userMessage }];

  // 4. GENERAR RESPUESTA CON LA IA
  let answer = "";
  try {
    answer = await aiReply(messages);
  } catch (err) {
    answer = "Puedo ayudarte con inmersiones, cursos y reservas.";
  }

  // 5. GUARDAR AMBOS MENSAJES EN LA BASE DE DATOS
  await pool.query(
    "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'usuario', $2)",
    [idSesion, userMessage]
  );
  await pool.query(
    "INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)",
    [idSesion, answer]
  );

  return answer;
}

/* ========= ARRANQUE ========= */
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Assistant running on port ${port}`);
});