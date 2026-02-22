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
  
  const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash", // ¡Ya corregido!
    systemInstruction: systemMsg
  });

  const geminiHistory = history.slice(0, -1).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  
  const lastMessage = history[history.length - 1].content;

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

/* ========= RUTA SECRETA PARA MIGRAR DATOS ========= */
app.get("/migrar-faqs", async (req, res) => {
  // Aquí hemos dejado el hueco preparado para rellenar tus 26 preguntas
  const misPreguntas = [
    // ==========================================
    // 🇪🇸 FAQS EN ESPAÑOL
    // ==========================================
    { 
      categoria: "Actividades", 
      pregunta_ejemplo: "¿En qué consiste y cuánto cuesta el Bautismo?", 
      respuesta: "Primera experiencia de buceo guiada por instructor. Precio: 75€. Requisitos: Edad mínima 10 años, sin certificación, apto médico recomendado. Horarios: 09:30 y 15:00.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Cursos", 
      pregunta_ejemplo: "¿Qué es el curso Open Water y cuál es el precio?", 
      respuesta: "Curso de iniciación que incluye teoría, piscina y mar. Precio: 380€. Requisitos: Edad mínima 10 años y apto médico. Horario: 09:00 a 18:00.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Cursos", 
      pregunta_ejemplo: "¿En qué consiste el curso Advanced y cuánto cuesta?", 
      respuesta: "Curso avanzado para mejorar habilidades y profundidad. Precio: 320€. Requisitos: Certificación Open Water y experiencia reciente. Horario: 09:00 a 18:00.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Actividades", 
      pregunta_ejemplo: "¿Hacéis inmersiones guiadas y qué precio tienen?", 
      respuesta: "Salidas en Benidorm con guía titulado. Precio: 45€. Requisitos: Certificación vigente y seguro si aplica. Horarios: 09:30 y 15:00.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Servicios", 
      pregunta_ejemplo: "¿Alquiláis equipo de buceo?", 
      respuesta: "Sí, tenemos material de buceo disponible para cursos y salidas. Precio a consultar. Sujeto a disponibilidad y talla.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Servicios", 
      pregunta_ejemplo: "¿Tenéis Nitrox para las inmersiones?", 
      respuesta: "Sí, disponemos de mezcla enriquecida (Nitrox) bajo solicitud. Precio a consultar. Requiere certificación Nitrox.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Actividades", 
      pregunta_ejemplo: "¿Hacéis salidas de Snorkel?", 
      respuesta: "Sí, excursión de snorkel guiada en Benidorm por la mañana o tarde. Precio a consultar. Solo necesitas saber nadar.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Información General", 
      pregunta_ejemplo: "¿Dónde estáis ubicados?", 
      respuesta: "Estamos en el Puerto Comercial Benidorm, Paseo de Colón, 1 - Caseta 30, Benidorm (Alicante).", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Información General", 
      pregunta_ejemplo: "¿Cuáles son vuestros horarios?", 
      respuesta: "Nuestro horario en Benidorm es de 09:00 a 18:00. Las salidas al mar son a las 09:30 y a las 15:00.", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Reservas", 
      pregunta_ejemplo: "¿Cuál es la política de reservas y cancelaciones?", 
      respuesta: "Pedimos una señal del 20% para reservar. Las cancelaciones deben hacerse con 48h de antelación. Puedes pagar aquí: https://revolutiondive.com/paga-aqui/", 
      idioma: "es", activa: true 
    },
    { 
      categoria: "Contacto", 
      pregunta_ejemplo: "¿Cómo puedo contactar con vosotros?", 
      respuesta: "Puedes escribirnos a reservas@revolutiondive.com o llamarnos al +34 618 406 991.", 
      idioma: "es", activa: true 
    },

    // ==========================================
    // 🇬🇧 FAQS EN INGLÉS (Generadas por la IA)
    // ==========================================
    { 
      categoria: "Activities", 
      pregunta_ejemplo: "What is the Try Dive (Bautismo) and how much does it cost?", 
      respuesta: "First guided diving experience with an instructor. Price: 75€. Requirements: Minimum age 10, no certification needed, medical clearance recommended. Times: 09:30 and 15:00.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Courses", 
      pregunta_ejemplo: "What is the Open Water course and what is the price?", 
      respuesta: "Beginner course including theory, pool, and sea dives. Price: 380€. Requirements: Minimum age 10 and medical clearance. Schedule: 09:00 to 18:00.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Courses", 
      pregunta_ejemplo: "What does the Advanced course consist of and how much is it?", 
      respuesta: "Advanced course to improve skills and depth. Price: 320€. Requirements: Open Water certification and recent experience. Schedule: 09:00 to 18:00.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Activities", 
      pregunta_ejemplo: "Do you offer guided dives and what is the price?", 
      respuesta: "Guided trips in Benidorm with a certified guide. Price: 45€. Requirements: Valid certification and insurance if applicable. Times: 09:30 and 15:00.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Services", 
      pregunta_ejemplo: "Do you rent diving equipment?", 
      respuesta: "Yes, diving equipment is available for courses and trips. Price on request. Subject to availability and size.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Services", 
      pregunta_ejemplo: "Do you have Nitrox for dives?", 
      respuesta: "Yes, enriched air (Nitrox) is available upon request. Price on request. Requires Nitrox certification.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Activities", 
      pregunta_ejemplo: "Do you organize snorkeling trips?", 
      respuesta: "Yes, guided snorkeling excursions in Benidorm available morning or afternoon. Price on request. You just need to know how to swim.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "General Information", 
      pregunta_ejemplo: "Where are you located?", 
      respuesta: "We are located at Puerto Comercial Benidorm, Paseo de Colón, 1 - Caseta 30, Benidorm (Alicante).", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "General Information", 
      pregunta_ejemplo: "What are your opening hours?", 
      respuesta: "Our opening hours in Benidorm are from 09:00 to 18:00. Sea trips depart at 09:30 and 15:00.", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Bookings", 
      pregunta_ejemplo: "What is the booking and cancellation policy?", 
      respuesta: "A 20% deposit is required to book. Cancellations must be made 48 hours in advance. You can pay here: https://revolutiondive.com/paga-aqui/", 
      idioma: "en", activa: true 
    },
    { 
      categoria: "Contact", 
      pregunta_ejemplo: "How can I contact you?", 
      respuesta: "You can email us at reservas@revolutiondive.com or call us at +34 618 406 991.", 
      idioma: "en", activa: true 
    }
  ];

  try {
    const batch = db.batch(); // Esto prepara un "paquete" para subir todo a la vez
    
    misPreguntas.forEach(faq => {
      // Le decimos que lo guarde en neo1 > conocimiento_faqs y genere el ID automático
      const docRef = db.collection('conocimiento_faqs').doc(); 
      batch.set(docRef, faq);
    });

    await batch.commit(); // Pulsa el "botón rojo" y sube todo
    res.send("<h1>¡Misión Cumplida! Todas las FAQs están en Firestore.</h1>");
  } catch (error) {
    res.status(500).send("Hubo un error: " + error.message);
  }
});

/* ========= ARRANQUE ========= */
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});