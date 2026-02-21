const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");

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

/* ========= INTELIGENCIA ARTIFICIAL (GEMINI) ========= */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

async function aiReply(messages) {
  if (!genAI) throw new Error("La clave de Gemini no está configurada");
  
  // Separamos las instrucciones del sistema del resto de la charla
  const systemMsg = messages.find(m => m.role === "system")?.content || "";
  const history = messages.filter(m => m.role !== "system");
  
  // Configuramos el motor de Google
  const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    systemInstruction: systemMsg
  });

  // Adaptamos el historial al formato de Gemini
  const geminiHistory = history.slice(0, -1).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  
  const lastMessage = history[history.length - 1].content;

  // Iniciamos el chat y enviamos el mensaje
  const chat = model.startChat({
    history: geminiHistory,
    generationConfig: { temperature: 0.2 },
  });

  const result = await chat.sendMessage(lastMessage);
  return result.response.text();
}

/* ========= LÓGICA DEL CHAT ========= */
app.post("/chat", async (req, res) => {
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
  // 1. BUSCAR O CREAR USUARIO
  let userQuery = await pool.query('SELECT id_usuario FROM usuarios WHERE telefono = $1', [telefono]);
  let idUsuario;
  if (userQuery.rows.length === 0) {
    const newUser = await pool.query('INSERT INTO usuarios (telefono) VALUES ($1) RETURNING id_usuario', [telefono]);
    idUsuario = newUser.rows[0].id_usuario;
  } else {
    idUsuario = userQuery.rows[0].id_usuario;
  }

  // 2. BUSCAR O CREAR SESIÓN
  let sessionQuery = await pool.query(
    "SELECT id_sesion FROM sesiones_chat WHERE id_usuario = $1 AND estado = 'abierta' ORDER BY fecha_inicio DESC LIMIT 1", [idUsuario]
  );
  let idSesion;
  if (sessionQuery.rows.length === 0) {
    const newSession = await pool.query("INSERT INTO sesiones_chat (id_usuario, plataforma) VALUES ($1, 'web') RETURNING id_sesion", [idUsuario]);
    idSesion = newSession.rows[0].id_sesion;
  } else {
    idSesion = sessionQuery.rows[0].id_sesion;
  }

  // 3. RECUPERAR HISTORIAL
  const historyQuery = await pool.query(
    'SELECT remitente, contenido FROM mensajes WHERE id_sesion = $1 ORDER BY fecha_hora ASC LIMIT 20', [idSesion]
  );
  const dbHistory = historyQuery.rows.map(row => ({
    role: row.remitente === 'usuario' ? 'user' : 'assistant',
    content: row.contenido
  }));

  // 4. DETECTAR IDIOMA Y LEER FAQs DE LA BD
  const text = normalize(userMessage);
  const lang = /hello|hi|price|book/.test(text) ? "en" : "es";
  
  const faqsQuery = await pool.query(
    "SELECT categoria, pregunta_ejemplo, respuesta FROM conocimiento_faqs WHERE idioma = $1 AND activa = true", [lang]
  );
  
  const faqsText = faqsQuery.rows.map(faq => 
    `Categoría: ${faq.categoria} | Pregunta: ${faq.pregunta_ejemplo} | Respuesta: ${faq.respuesta}`
  ).join("\n");

  const benidormInfo = lang === "en" 
    ? "Benidorm Island is a popular dive site. Good visibility (10-25m). Common species: moray eel, octopus, grouper, etc." 
    : "La isla de Benidorm es un punto popular. Buena visibilidad (10-25m). Especies: morena, pulpo, mero, etc.";

  const systemMessage = {
    role: "system",
    content: `Actúa como un asistente experto del centro de buceo. Tu objetivo es informar sobre cursos e inmersiones basándote EXCLUSIVAMENTE en el siguiente conocimiento. Sé breve, directo y amable.\n\nCONOCIMIENTO DEL CENTRO:\n${faqsText}\n\nINFO EXTRA:\n${benidormInfo}`
  };

  const messages = [systemMessage, ...dbHistory, { role: "user", content: userMessage }];

  // 5. GENERAR RESPUESTA CON GEMINI
  let answer = "";
  try {
    answer = await aiReply(messages);
  } catch (err) {
    console.error("Error IA:", err);
    answer = lang === "en" ? "I can help with dives, courses and bookings." : "Puedo ayudarte con inmersiones, cursos y reservas.";
  }

  // 6. GUARDAR MENSAJES
  await pool.query("INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'usuario', $2)", [idSesion, userMessage]);
  await pool.query("INSERT INTO mensajes (id_sesion, remitente, contenido) VALUES ($1, 'bot', $2)", [idSesion, answer]);

  return answer;
}

/* ========= ARRANQUE ========= */
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});