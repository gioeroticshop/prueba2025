# WhatsApp Bot con Baileys

Bot de WhatsApp que responde automáticamente "tus apellidos son casanova" cuando recibe el mensaje "hola jairo".

## 🚀 Características

- ✅ Conexión automática a WhatsApp usando Baileys
- 🤖 Respuesta automática a mensajes específicos
- 📱 Interfaz web para monitorear mensajes
- 🔄 Reconexión automática
- 📊 Estadísticas de mensajes
- 🌐 Compatible con Render (servicio gratuito)

## 📦 Instalación Local

1. **Clonar el repositorio:**
```bash
git clone <tu-repositorio>
cd whatsapp-baileys-bot
```

2. **Instalar dependencias:**
```bash
npm install
```

3. **Ejecutar en modo desarrollo:**
```bash
npm run dev
```

4. **Abrir en navegador:**
```
http://localhost:3000
```

## 🌐 Despliegue en Render

### Pasos para desplegar:

1. **Subir código a GitHub:**
   - Crear repositorio en GitHub
   - Subir todos los archivos del proyecto

2. **Crear servicio en Render:**
   - Ir a [render.com](https://render.com)
   - Crear cuenta gratuita
   - Conectar con GitHub
   - Seleccionar tu repositorio

3. **Configuración del servicio:**
   - **Name:** whatsapp-bot-jairo
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Port:** 3000

4. **Variables de entorno (opcional):**
   ```
   NODE_ENV=production
   ```

### ⚠️ Importante para Render gratuito:

- El servicio se "duerme" después de 15 minutos de inactividad
- Se incluye un keep-alive que hace ping cada 25 segundos
- La primera conexión puede ser lenta (cold start)

## 📱 Cómo usar

1. **Conectar WhatsApp:**
   - Abrir la interfaz web
   - Escanear el código QR con WhatsApp
   - Esperar confirmación de conexión

2. **El bot responderá automáticamente:**
   - Cuando alguien escriba: "hola jairo"
   - El bot responderá: "tus apellidos son casanova"

3. **Monitorear mensajes:**
   - Ver todos los mensajes en la interfaz web
   - Estadísticas de mensajes enviados/recibidos
   - Estado de conexión en tiempo real

## 🛠️ Estructura del proyecto

```
whatsapp-baileys-bot/
├── server.js              # Servidor principal
├── package.json           # Dependencias
├── Dockerfile            # Para contenedor
├── .gitignore           # Archivos a ignorar
├── README.md           # Este archivo
└── public/
    └── index.html      # Interfaz web
```

## 🔧 Configuración avanzada

### Personalizar respuesta:
En `server.js`, línea ~95:
```javascript
if (messageText.toLowerCase().includes('hola jairo')) {
  await sock.sendMessage(contact, { text: 'tus apellidos son casanova' });
}
```

### Cambiar palabra clave:
Reemplazar `'hola jairo'` por tu palabra clave deseada.

### Cambiar respuesta:
Reemplazar `'tus apellidos son casanova'` por tu respuesta deseada.

## 📊 Funcionalidades de la interfaz

- **Código QR:** Para conectar WhatsApp
- **Estado de conexión:** Indicador visual
- **Lista de mensajes:** Enviados y recibidos
- **Estadísticas:** Contadores en tiempo real
- **Responsive:** Compatible con móviles

## 🐛 Solución de problemas

### El bot no responde:
1. Verificar conexión en la interfaz web
2. Revisar logs en Render
3. Reescanear código QR si es necesario

### Servicio se duerme en Render:
- Es normal en el plan gratuito
- El keep-alive ayuda a mantenerlo activo
- Considera usar un servicio de ping externo

### Error de autenticación:
1. Borrar carpeta `auth_info_baileys`
2. Reiniciar servicio
3. Escanear nuevo código QR

## 📝 Logs importantes

El bot registra:
- Conexiones y desconexiones
- Mensajes recibidos y enviados
- Errores de conexión
- Keep-alive pings

## 🚨 Limitaciones

- **Render gratuito:** 750 horas/mes, se duerme tras inactividad
- **WhatsApp:** Límites de API no oficiales
- **Mensajes:** Solo texto básico soportado

## ⚡ Optimizaciones incluidas

- Reconexión automática tras desconexión
- Keep-alive para prevenir sleep en Render
- Límite de 100 mensajes en memoria
- Socket.IO para tiempo real
- Interfaz responsive

## 📞 Soporte

Si tienes problemas:
1. Revisar logs en Render Dashboard
2. Verificar código QR actualizado
3. Comprobar estado de conexión en interfaz

¡Tu bot está listo para funcionar 24/7 respondiendo a "hola jairo"! 🤖
