# 🤖 Chatbot IA para WordPress con Google Cloud y Firebase

Un asistente virtual inteligente desarrollado en Node.js, diseñado para integrarse fácilmente en sitios web. El chatbot automatiza la atención al cliente respondiendo preguntas frecuentes (FAQs) en múltiples idiomas y actúa como herramienta de captación de *leads*, almacenando los datos de contacto directamente en Firebase.

## ✨ Características Principales

* **Soporte Multilingüe:** Respuestas dinámicas basadas en archivos JSON de FAQs (Soporta Español e Inglés).
* **Captura de Leads:** Recopila información de contacto de usuarios interesados y la sincroniza en tiempo real con una base de datos.
* **Integración con WordPress:** Diseñado para conectarse de forma nativa o mediante un script/widget en cualquier CMS WordPress.
* **Arquitectura Cloud:** Uso de los servicios de Google Cloud y almacenamiento en la nube para garantizar alta disponibilidad y escalabilidad.
* **Contenedorizado:** Entorno de despliegue estandarizado utilizando Docker.

## 🛠️ Stack Tecnológico

* **Backend:** Node.js, JavaScript
* **Inteligencia Artificial / NLP:** Google
* **Base de Datos:** Firebase (Cloud Firestore / Realtime Database)
* **Infraestructura & Deployment:** Google Cloud Platform (GCP), Docker
* **Integración:** WordPress

## 🏗️ Arquitectura del Sistema

1. **Frontend (WordPress):** El usuario interactúa con el widget del chat en la web.
2. **Backend (Node.js):** Procesa la solicitud. Si es una pregunta de soporte, consulta la base de conocimientos (`faqs.es.json` / `faqs.en.json`). Si requiere procesamiento de lenguaje natural, se comunica con [Tu Motor de IA].
3. **Almacenamiento (Firebase):** Si el usuario proporciona datos de contacto o solicita un servicio, el módulo `leadsStore.js` guarda esta información de forma segura en Firebase.

## 🚀 Instalación y Despliegue en Local

### Requisitos Previos
* Node.js (v14 o superior)
* Docker (Opcional, para despliegue en contenedor)
* Cuenta de Google Cloud y proyecto de Firebase configurado.

### Pasos

1. **Clonar el repositorio:**
   ```bash
   git clone [https://github.com/tu-usuario/tu-repositorio.git](https://github.com/tu-usuario/tu-repositorio.git)
   cd tu-repositorio
