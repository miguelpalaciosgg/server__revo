# Usamos una versión ligera de Node.js
FROM node:18-slim

# Creamos la carpeta de trabajo
WORKDIR /app

# Copiamos los archivos de dependencias
COPY package*.json ./

# Instalamos las librerías
RUN npm install

# Copiamos el resto de tu código (incluido tu index.js corregido)
COPY . .

# Exponemos el puerto que usa tu servidor
EXPOSE 8080

# Comando para encender el bot
CMD ["node", "index.js"]