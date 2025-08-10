// server.js - Versión corregida con mejor manejo de sesión + API para envío de mensajes
require('dotenv').config(); // NEW: Cargar variables de entorno
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const https = require('https');
const rateLimit = require('express-rate-limit'); // NEW: Rate limiting

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` || null;

// Logger más detallado
const logger = P({ 
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

// Variables globales
let sock;
let qrCodeData = null;
let isConnected = false;
let messages = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5; // Reducido para evitar loops infinitos

// Estadísticas del keep-alive
let keepAliveStats = {
  totalPings: 0,
  successfulPings: 0,
  failedPings: 0,
  lastPing: null,
  lastSuccess: null
};

// Variable para evitar múltiples intentos de conexión simultáneos
let isConnecting = false;

// NEW: Middleware para parsear JSON
app.use(express.json());

// NEW: Rate limiting - 30 peticiones por minuto por IP
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // máximo 30 requests por minuto
  message: {
    success: false,
    error: 'Too many requests, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint de salud mejorado (UPDATED: formato requerido + información adicional)
app.get('/health', (req, res) => {
  res.json({
    success: true, // NEW: formato requerido
    connected: isConnected, // NEW: formato requerido
    timestamp: new Date().toISOString(), // NEW: formato requerido
    // Información adicional del sistema (mantenida)
    status: 'ok',
    uptime: process.uptime(),
    messages: messages.length,
    reconnectAttempts: reconnectAttempts,
    keepAlive: keepAliveStats,
    isConnecting: isConnecting
  });
});

// Endpoint para auto-ping
app.get('/ping', (req, res) => {
  const pingTime = new Date().toISOString();
  console.log(`🏓 Self-ping recibido: ${pingTime}`);

  res.json({
    pong: true,
    timestamp: pingTime,
    uptime: process.uptime(),
    connected: isConnected,
    message: 'Bot activo y funcionando'
  });
});

// NEW: Endpoint para enviar mensajes desde aplicaciones externas
app.post('/send-message', messageLimiter, (req, res) => {
  try {
    // Validar autenticación
    const authHeader = req.headers.authorization;
    const expectedToken = `Bearer ${process.env.BOT_API_KEY}`;

    if (!authHeader || authHeader !== expectedToken) {
      console.log('❌ Intento de acceso no autorizado al endpoint /send-message');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    // Validar que el bot esté conectado
    if (!isConnected || !sock || !sock.user) {
      console.log('⚠️ Intento de envío de mensaje con WhatsApp desconectado');
      return res.status(503).json({
        success: false,
        error: 'WhatsApp not connected'
      });
    }

    // Validar datos del request
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        error: 'Phone and message are required'
      });
    }

    if (typeof phone !== 'string' || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Phone and message must be strings'
      });
    }

    if (phone.trim() === '' || message.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Phone and message cannot be empty'
      });
    }

    // Normalizar número de teléfono
    let normalizedPhone = phone.replace(/[\s\-\(\)\+]/g, ''); // Eliminar espacios, guiones, paréntesis y +

    // Asegurar formato internacional sin +
    if (!normalizedPhone.includes('@')) {
      normalizedPhone = normalizedPhone + '@s.whatsapp.net';
    }

    console.log(`📤 API: Enviando mensaje a ${phone} (normalizado: ${normalizedPhone})`);

    // Enviar mensaje usando el socket existente
    sock.sendMessage(normalizedPhone, { text: message.trim() })
      .then(() => {
        // Guardar el mensaje enviado en el historial
        const messageData = {
          id: Date.now().toString(),
          from: 'API Bot',
          contact: normalizedPhone,
          text: message.trim(),
          timestamp: new Date(),
          type: 'sent'
        };

        messages.unshift(messageData);
        if (messages.length > 100) messages.pop();

        // Emitir a la interfaz web
        io.emit('new-message', messageData);

        // Guardar mensajes
        saveMessages();

        console.log(`✅ API: Mensaje enviado exitosamente a ${phone}`);

        res.json({
          success: true
        });
      })
      .catch((error) => {
        console.error('❌ API: Error enviando mensaje:', error);

        // Si hay error de conexión, marcar como desconectado
        if (error.message.includes('Connection Closed') ||
            error.message.includes('Socket') ||
            error.message.includes('ECONNRESET')) {
          console.log('🔄 API: Error de conexión detectado, marcando como desconectado');
          isConnected = false;
          io.emit('connection-status', { connected: false, reconnecting: true });
        }

        res.status(500).json({
          success: false,
          error: 'Failed to send message'
        });
      });

  } catch (error) {
    console.error('❌ API: Error crítico en /send-message:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Función mejorada de keep-alive interna
function performSelfPing() {
  if (!RENDER_URL) {
    console.log('⚠️ URL de Render no configurada, saltando self-ping');
    return;
  }

  const startTime = Date.now();
  keepAliveStats.totalPings++;
  keepAliveStats.lastPing = new Date().toISOString();

  console.log(`🚀 Enviando self-ping #${keepAliveStats.totalPings} a ${RENDER_URL}/ping`);

  const req = https.get(`${RENDER_URL}/ping`, { timeout: 15000 }, (res) => {
    const responseTime = Date.now() - startTime;
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        keepAliveStats.successfulPings++;
        keepAliveStats.lastSuccess = new Date().toISOString();
        
        console.log(`✅ Self-ping exitoso (${responseTime}ms) - Uptime: ${Math.floor(response.uptime)}s, WhatsApp: ${response.connected ? 'Conectado' : 'Desconectado'}`);
        
        // Si el bot está desconectado, intentar reconectar
        if (!response.connected && !isConnecting) {
          console.log('🔄 Bot desconectado detectado via ping, intentando reconectar...');
          connectToWhatsApp();
        }
      } catch (error) {
        console.log(`⚠️ Self-ping recibido pero respuesta inválida: ${data.substring(0, 100)}`);
        keepAliveStats.failedPings++;
      }
    });
  });

  req.on('timeout', () => {
    console.log(`⏰ Timeout en self-ping #${keepAliveStats.totalPings}`);
    keepAliveStats.failedPings++;
    req.destroy();
  });

  req.on('error', (error) => {
    console.log(`❌ Error en self-ping #${keepAliveStats.totalPings}:`, error.message);
    keepAliveStats.failedPings++;
  });
}

// Configurar tareas cron con menos frecuencia para evitar spam
function setupCronJobs() {
  // Keep-alive cada 13 minutos (para evitar el sleep de 15 min de Render)
  cron.schedule('*/13 * * * *', () => {
    console.log('⏰ Ejecutando tarea cron: Keep-alive automático');
    performSelfPing();
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  // Limpieza cada 2 horas en lugar de cada hora
  cron.schedule('0 */2 * * *', () => {
    console.log('⏰ Ejecutando tarea cron: Limpieza de mensajes');
    
    if (messages.length > 50) {
      const oldLength = messages.length;
      messages = messages.slice(0, 50);
      console.log(`🧹 Limpieza completada: ${oldLength} -> ${messages.length} mensajes`);
      saveMessages();
    }
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  // Reporte cada 12 horas
  cron.schedule('0 */12 * * *', () => {
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    console.log('📊 === REPORTE DE ESTADÍSTICAS ===');
    console.log(`⏱️ Uptime: ${hours}h ${minutes}m`);
    console.log(`📱 WhatsApp: ${isConnected ? 'Conectado' : 'Desconectado'}`);
    console.log(`💬 Mensajes en memoria: ${messages.length}`);
    console.log(`🔄 Reintentos de conexión: ${reconnectAttempts}`);
    console.log(`🏓 Keep-alive - Total: ${keepAliveStats.totalPings}, Exitosos: ${keepAliveStats.successfulPings}, Fallidos: ${keepAliveStats.failedPings}`);
    console.log('================================');
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  console.log('⏰ Tareas cron configuradas con frecuencia optimizada');
}

// Función para cargar mensajes
function loadMessages() {
  try {
    if (fs.existsSync('messages.json')) {
      const data = fs.readFileSync('messages.json', 'utf8');
      messages = JSON.parse(data);
      console.log(`📚 Cargados ${messages.length} mensajes del archivo`);
    }
  } catch (error) {
    console.error('❌ Error cargando mensajes:', error);
    messages = [];
  }
}

// Función para guardar mensajes
function saveMessages() {
  try {
    const messagesToSave = messages.slice(0, 50);
    fs.writeFileSync('messages.json', JSON.stringify(messagesToSave, null, 2));
    console.log(`💾 Guardados ${messagesToSave.length} mensajes`);
  } catch (error) {
    console.error('❌ Error guardando mensajes:', error);
  }
}

// Función mejorada para limpiar archivos de autenticación
function cleanAuthFiles() {
  try {
    const authDir = 'auth_info_baileys';
    if (fs.existsSync(authDir)) {
      console.log('🧹 Limpiando archivos de autenticación...');
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log('✅ Archivos de autenticación limpiados');
      reconnectAttempts = 0;
    }
  } catch (error) {
    console.error('❌ Error limpiando archivos de auth:', error);
  }
}

// Función mejorada para conectar WhatsApp
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('⚠️ Ya hay un intento de conexión en progreso, ignorando...');
    return;
  }

  isConnecting = true;
  
  try {
    console.log(`🔄 Iniciando conexión a WhatsApp (intento ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
    
    // Si hay demasiados intentos fallidos, limpiar autenticación
    if (reconnectAttempts >= 3) {
      console.log('🧹 Demasiados intentos fallidos, limpiando autenticación...');
      cleanAuthFiles();
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // Configuración más robusta del socket
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger,
      browser: ["WhatsApp Bot", "Desktop", "4.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false, // Cambiado a false para ser menos detectado
      connectTimeoutMs: 90000, // Aumentado timeout
      defaultQueryTimeoutMs: 90000,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 3,
      // Configuración para mejor estabilidad
      shouldIgnoreJid: jid => false,
      shouldSyncHistoryMessage: msg => false,
      getMessage: async (key) => {
        return {
          conversation: 'Mensaje no disponible'
        };
      }
    });

    // Manejar actualizaciones de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log('📡 Estado de conexión:', connection);
      
      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          io.emit('qr', qrCodeData);
          console.log('📱 QR Code generado - Escanear con WhatsApp');
        } catch (err) {
          console.error('❌ Error generando QR:', err);
        }
      }

      if (connection === 'close') {
        isConnecting = false;
        isConnected = false;
        
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        const reason = lastDisconnect?.error?.output?.statusCode;
        
        console.log(`❌ Conexión cerrada. Razón: ${reason}, Debería reconectar: ${shouldReconnect}`);
        
        // Mapeo de razones de desconexión
        const reasonMap = {
          [DisconnectReason.badSession]: 'Sesión corrupta',
          [DisconnectReason.connectionClosed]: 'Conexión cerrada',
          [DisconnectReason.connectionLost]: 'Conexión perdida',
          [DisconnectReason.connectionReplaced]: 'Conexión reemplazada',
          [DisconnectReason.loggedOut]: 'Sesión cerrada',
          [DisconnectReason.restartRequired]: 'Reinicio requerido',
          [DisconnectReason.timedOut]: 'Tiempo agotado',
          [DisconnectReason.multideviceMismatch]: 'Error multi-dispositivo'
        };
        
        console.log(`📋 Motivo detallado: ${reasonMap[reason] || 'Desconocido'}`);
        
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(10000 * reconnectAttempts, 60000); // Delay más largo
          
          console.log(`🔄 Reintentando en ${delay/1000}s (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          
          setTimeout(() => {
            connectToWhatsApp();
          }, delay);
        } else if (reason === DisconnectReason.loggedOut || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.log('🗑️ Sesión perdida o máximo de reintentos. Limpiando y reiniciando...');
          cleanAuthFiles();
          reconnectAttempts = 0;
          setTimeout(() => {
            connectToWhatsApp();
          }, 30000); // Esperar más tiempo antes de reiniciar
        }
        
        io.emit('connection-status', { connected: false, reconnecting: shouldReconnect });
        io.emit('qr', null);
        
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado exitosamente!');
        isConnected = true;
        isConnecting = false;
        qrCodeData = null;
        reconnectAttempts = 0;
        
        io.emit('connection-status', { connected: true, reconnecting: false });
        io.emit('qr', null);
        
        // Guardar credenciales inmediatamente
        try {
          await saveCreds();
          console.log('💾 Credenciales guardadas exitosamente');
        } catch (error) {
          console.error('❌ Error guardando credenciales:', error);
        }
        
      } else if (connection === 'connecting') {
        console.log('🔄 Conectando a WhatsApp...');
        io.emit('connection-status', { connected: false, reconnecting: true });
      }
    });

    // Guardar credenciales cuando se actualicen
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        console.log('🔐 Credenciales actualizadas y guardadas');
      } catch (error) {
        console.error('❌ Error actualizando credenciales:', error);
      }
    });

    // Manejar mensajes entrantes con mejor error handling
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        
        // Ignorar mensajes propios y mensajes sin contenido
        if (!message.key.fromMe && message.message) {
          const messageText = message.message.conversation || 
                             message.message.extendedTextMessage?.text || '';
          
          const contact = message.key.remoteJid;
          const contactName = message.pushName || contact.split('@')[0];
          
          const messageData = {
            id: message.key.id,
            from: contactName,
            contact: contact,
            text: messageText,
            timestamp: new Date(),
            type: 'received'
          };
          
          messages.unshift(messageData);
          if (messages.length > 100) messages.pop();
          
          // Guardar mensajes cada 5 mensajes nuevos
          if (messages.length % 5 === 0) {
            saveMessages();
          }
          
          io.emit('new-message', messageData);
          console.log(`📨 Mensaje de ${contactName}: ${messageText}`);
          
          // Responder al mensaje específico
          if (messageText.toLowerCase().includes('hola jairo')) {
            try {
              // Verificar que el socket esté conectado antes de enviar
              if (sock && isConnected && sock.user) {
                await sock.sendMessage(contact, { text: 'tus apellidos son casanova' });
                
                const responseData = {
                  id: Date.now().toString(),
                  from: 'Bot',
                  contact: contact,
                  text: 'tus apellidos son casanova',
                  timestamp: new Date(),
                  type: 'sent'
                };
                
                messages.unshift(responseData);
                io.emit('new-message', responseData);
                console.log(`📤 Respuesta enviada a ${contactName}`);
                
                saveMessages();
              } else {
                console.log('⚠️ Socket no disponible para enviar mensaje');
              }
            } catch (error) {
              console.error('❌ Error enviando mensaje:', error);
              
              // Si hay error de conexión, marcar como desconectado
              if (error.message.includes('Connection Closed') || 
                  error.message.includes('Socket') ||
                  error.message.includes('ECONNRESET')) {
                console.log('🔄 Error de conexión detectado, marcando como desconectado');
                isConnected = false;
                io.emit('connection-status', { connected: false, reconnecting: true });
              }
            }
          }
        }
      } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
      }
    });

  } catch (error) {
    console.error('❌ Error crítico conectando a WhatsApp:', error);
    isConnecting = false;
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = Math.min(15000 * reconnectAttempts, 60000);
      console.log(`🔄 Reintentando conexión en ${delay/1000}s debido a error crítico`);
      setTimeout(() => {
        connectToWhatsApp();
      }, delay);
    } else {
      console.log('💀 Máximo de reintentos alcanzado, limpiando todo y esperando...');
      cleanAuthFiles();
      reconnectAttempts = 0;
      setTimeout(() => {
        connectToWhatsApp();
      }, 120000); // Esperar 2 minutos
    }
  }
}

// Socket.IO para la interfaz web
io.on('connection', (socket) => {
  console.log('🌐 Cliente conectado a la interfaz web');
  
  socket.emit('connection-status', { connected: isConnected });
  socket.emit('messages-history', messages);
  
  if (qrCodeData) {
    socket.emit('qr', qrCodeData);
  } else if (isConnected) {
    socket.emit('qr', null);
  }
  
  socket.on('disconnect', () => {
    console.log('🌐 Cliente desconectado de la interfaz web');
  });
});

// Inicializar aplicación
async function initApp() {
  console.log('🚀 Iniciando WhatsApp Bot v2.0 con correcciones');
  console.log(`🌐 URL de Render: ${RENDER_URL || 'No detectada automáticamente'}`);
  
  // Crear directorio de autenticación si no existe
  if (!fs.existsSync('auth_info_baileys')) {
    fs.mkdirSync('auth_info_baileys', { recursive: true });
    console.log('📁 Directorio de autenticación creado');
  }
  
  // Cargar mensajes guardados
  loadMessages();
  
  // Configurar tareas cron
  setupCronJobs();
  
  // Iniciar servidor
  server.listen(PORT, () => {
    console.log(`✅ Servidor ejecutándose en puerto ${PORT}`);
    console.log(`💚 Salud del servidor: http://localhost:${PORT}/health`);
    console.log(`🏓 Endpoint de ping: http://localhost:${PORT}/ping`);
    
    // Esperar un poco antes de iniciar la conexión
    setTimeout(() => {
      connectToWhatsApp();
    }, 2000);
    
    // Primer ping después de 3 minutos
    if (RENDER_URL) {
      setTimeout(() => {
        console.log('🎯 Realizando primer self-ping...');
        performSelfPing();
      }, 180000);
    }
  });
}

// Manejo mejorado de cierre graceful
process.on('SIGINT', async () => {
  console.log('🛑 Cerrando aplicación (SIGINT)...');
  await gracefulShutdown();
});

process.on('SIGTERM', async () => {
  console.log('🛑 Cerrando aplicación (SIGTERM)...');
  await gracefulShutdown();
});

async function gracefulShutdown() {
  console.log('💾 Guardando mensajes...');
  saveMessages();
  
  if (sock && isConnected) {
    try {
      console.log('👋 Cerrando sesión de WhatsApp...');
      await sock.logout();
    } catch (error) {
      console.error('❌ Error cerrando socket:', error);
    }
  }
  
  console.log('✅ Aplicación cerrada correctamente');
  process.exit(0);
}

// Heartbeat menos frecuente
setInterval(() => {
  const status = {
    timestamp: new Date().toISOString(),
    connected: isConnected,
    uptime: Math.floor(process.uptime()),
    messages: messages.length,
    reconnectAttempts: reconnectAttempts,
    isConnecting: isConnecting
  };
  console.log('💓 Heartbeat:', JSON.stringify(status));
}, 300000); // Cada 5 minutos

// Monitoreo de memoria para debugging
setInterval(() => {
  const memUsage = process.memoryUsage();
  if (memUsage.heapUsed > 100 * 1024 * 1024) { // Si usa más de 100MB
    console.log('🧠 Uso de memoria:', {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
    });
  }
}, 600000); // Cada 10 minutos

// Iniciar aplicación
initApp();
