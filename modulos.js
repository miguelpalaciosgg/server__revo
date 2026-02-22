const { GoogleGenerativeAI } = require('@google/generative-ai');

// Accede a tu clave de API de forma segura.
// Por ejemplo, desde una variable de entorno.
const API_KEY = 'AIzaSyAfOr_jXVqPVdOcePfkwk9CIgkKvQF2w1c';

if (!API_KEY) {
  console.error('La variable de entorno GEMINI_API_KEY no está definida.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

async function listGenerativeModels() {
  try {
    const { models } = await genAI.listModels();
    console.log('Modelos Generativos Disponibles:');
    models.forEach(model => {
      console.log(`- Nombre: ${model.name}`);
      console.log(`  Descripción: ${model.description}`);
      console.log(`  Versión de entrada: ${model.inputTokenLimit}`);
      console.log(`  Versión de salida: ${model.outputTokenLimit}`);
      console.log(`  Funcionalidades: ${model.supportedGenerationMethods.join(', ')}`);
      console.log('---');
    });
  } catch (error) {
    console.error('Error al obtener la lista de modelos:', error);
  }
}

listGenerativeModels();
