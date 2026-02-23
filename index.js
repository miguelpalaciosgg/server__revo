const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ========= CONEXIÓN A BASE DE DATOS FIRESTORE ========= */
// ¡Magia! No hace falta poner usuario, contraseña ni puerto.
const db = new Firestore({ databaseId: 'neo1' });

/* ========= UTIL ========= */
function normalize(str) {
  return (str ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* ========= INTELIGENCIA ARTIFICIAL (GEMINI) ========= */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

async function aiReply(messages) {
  if (!genAI) throw new Error("La clave de Gemini no está configurada");
  
  const systemMsg = messages.find(m => m.role === "system")?.content || "";
  const history = messages.filter(m => m.role !== "system");
  
  // Quitamos configuraciones complejas para evitar el error 400
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  // Construimos un único mensaje de texto gigante con toda la conversación
  let prompt = systemMsg + "\n\n--- HISTORIAL DE LA CONVERSACIÓN ---\n";
  
  history.slice(0, -1).forEach(m => {
    const remitente = m.role === "assistant" ? "Asistente" : "Usuario";
    prompt += `${remitente}: ${m.content}\n`;
  });
  
  const ultimoMensaje = history[history.length - 1].content;
  prompt += `\n--- NUEVO MENSAJE ---\nUsuario: ${ultimoMensaje}\nAsistente:`;

  // Generamos la respuesta de forma directa
  const result = await model.generateContent(prompt);
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
  // 1. BUSCAR O CREAR USUARIO EN FIRESTORE
  const usersRef = db.collection('usuarios');
  const userQuery = await usersRef.where('telefono', '==', telefono).get();
  
  let idUsuario;
  if (userQuery.empty) {
    const newUser = await usersRef.add({ 
      telefono: telefono, 
      fecha_creacion: Firestore.FieldValue.serverTimestamp() 
    });
    idUsuario = newUser.id;
  } else {
    idUsuario = userQuery.docs[0].id;
  }

  // 2. BUSCAR O CREAR SESIÓN
  const sessionsRef = db.collection('sesiones_chat');
  const sessionQuery = await sessionsRef
    .where('id_usuario', '==', idUsuario)
    .where('estado', '==', 'abierta')
    .get();
    
  let idSesion;
  if (sessionQuery.empty) {
    const newSession = await sessionsRef.add({ 
      id_usuario: idUsuario, 
      plataforma: 'web',
      estado: 'abierta',
      fecha_inicio: Firestore.FieldValue.serverTimestamp()
    });
    idSesion = newSession.id;
  } else {
    idSesion = sessionQuery.docs[0].id;
  }

  // 3. RECUPERAR HISTORIAL
  const historyQuery = await db.collection('mensajes')
    .where('id_sesion', '==', idSesion)
    .orderBy('fecha_hora', 'asc')
    .limit(20)
    .get();
    
  const dbHistory = historyQuery.docs.map(doc => {
    const data = doc.data();
    return {
      role: data.remitente === 'usuario' ? 'user' : 'assistant',
      content: data.contenido
    };
  });

  // 4. DETECTAR IDIOMA Y LEER FAQs DE FIRESTORE
  const text = normalize(userMessage);
  const lang = /hello|hi|price|book/.test(text) ? "en" : "es";
  
  const faqsQuery = await db.collection('conocimiento_faqs')
    .where('idioma', '==', lang)
    .where('activa', '==', true)
    .get();
  
  const faqsText = faqsQuery.docs.map(doc => {
    const faq = doc.data();
    return `Categoría: ${faq.categoria} | Pregunta: ${faq.pregunta_ejemplo} | Respuesta: ${faq.respuesta}`;
  }).join("\n");

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

  // 6. GUARDAR MENSAJES EN FIRESTORE
  await db.collection('mensajes').add({ 
    id_sesion: idSesion, 
    remitente: 'usuario', 
    contenido: userMessage,
    fecha_hora: Firestore.FieldValue.serverTimestamp()
  });
  
  await db.collection('mensajes').add({ 
    id_sesion: idSesion, 
    remitente: 'bot', 
    contenido: answer,
    fecha_hora: Firestore.FieldValue.serverTimestamp()
  });

  return answer;
}

/* ========= RUTA DE INYECCIÓN MASIVA DE DATOS ========= */
app.get("/inyectar-todo", async (req, res) => {
  const masterData = [
    // --- CURSOS AVANZADOS ---
    { categoria: "Cursos", idioma: "es", activa: true, pregunta_ejemplo: "¿Qué es el Rescue Diver?", respuesta: "El curso Rescue Diver enseña a gestionar problemas en el agua por 280€. Si haces el pack con EFR sale por 380€." },
    { categoria: "Cursos", idioma: "es", activa: true, pregunta_ejemplo: "¿Hacéis el curso de primeros auxilios?", respuesta: "Sí, el curso EFR (Emergency First Response) cuesta 120€ y es vital para buceadores de rescate." },
    { categoria: "Cursos", idioma: "es", activa: true, pregunta_ejemplo: "¿Puedo ser profesional del buceo?", respuesta: "Sí, impartimos el curso Dive Master por 380€ para iniciar tu carrera profesional." },
    
    // --- ESPECIALIDADES Y REFRESH ---
    { categoria: "Cursos", idioma: "es", activa: true, pregunta_ejemplo: "¿Qué especialidades tenéis?", respuesta: "Ofrecemos Nitrox, Buceo Profundo, Navegación, Nocturna, Flotabilidad y Traje Seco. ¡Pregúntanos precios!" },
    { categoria: "Cursos", idioma: "es", activa: true, pregunta_ejemplo: "Llevo tiempo sin bucear, ¿qué hago?", respuesta: "Te recomendamos un Refresh (recordatorio) desde 80€ con equipo incluido para recuperar confianza." },
    
    // --- SERVICIOS Y TIENDA ---
    { categoria: "Servicios", idioma: "es", activa: true, pregunta_ejemplo: "¿Tenéis tienda de buceo?", respuesta: "Sí, vendemos material de Mares, Cressi y Aqualung. Te asesoramos en la compra de tu equipo." },
    { categoria: "Servicios", idioma: "es", activa: true, pregunta_ejemplo: "¿Revisáis reguladores?", respuesta: "Sí, somos servicio técnico oficial para revisión de reguladores y cambio de baterías de ordenadores." },
    { categoria: "Información", idioma: "es", activa: true, pregunta_ejemplo: "¿El seguro de buceo es obligatorio?", respuesta: "Sí, es obligatorio. Si no tienes uno anual, podemos tramitarte uno diario o mensual en el centro." }
  ];

  try {
    const batch = db.batch();
    
    // Generamos las versiones en inglés automáticamente
    masterData.forEach(item => {
      // Guardar versión Español
      const docEs = db.collection('conocimiento_faqs').doc();
      batch.set(docEs, item);
      
      // Crear y guardar versión Inglés (Traducción rápida)
      const docEn = db.collection('conocimiento_faqs').doc();
      let resEn = item.respuesta;
      if(item.pregunta_ejemplo.includes("Rescue")) resEn = "Rescue Diver course: 280€. Rescue + EFR pack: 380€.";
      if(item.pregunta_ejemplo.includes("tiempo sin bucear")) resEn = "We offer Refresh courses from 80€ including equipment.";
      if(item.pregunta_ejemplo.includes("tienda")) resEn = "Yes, we have a shop with Mares, Cressi and Aqualung gear.";
      if(item.pregunta_ejemplo.includes("seguro")) resEn = "Dive insurance is mandatory. We can issue daily or monthly insurance at the center.";
      
      batch.set(docEn, { ...item, idioma: "en", respuesta: resEn });
    });

    await batch.commit();
    res.send("<h1>🚀 ¡Cerebro actualizado! Todos los datos de la web están en Firestore.</h1>");
  } catch (error) {
    res.status(500).send("Error: " + error.message);
  }
});

/* ========= ARRANQUE ========= */
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});