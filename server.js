// server.js - Versión mejorada con node-cron
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron'); // Importar node-cron
const https = require('https'); // Para hacer requests HTTP

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` || null;

// Logger
const logger = P({ level: 'silent' });

// Variables globales
let sock;
let qrCodeData = null;
let isConnected = false;
let messages = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Estadísticas del keep-alive
let keepAliveStats = {
  totalPings: 0,
  successfulPings: 0,
  failedPings: 0,
  lastPing: null,
  lastSuccess: null
};

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint de salud mejorado con estadísticas de keep-alive
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: isConnected, 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    messages: messages.length,
    reconnectAttempts: reconnectAttempts,
    keepAlive: keepAliveStats
  });
});

// Endpoint para auto-ping (keep-alive interno)
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

// Función de keep-alive interna
function performSelfPing() {
  if (!RENDER_URL) {
    console.log('⚠️ URL de Render no configurada, saltando self-ping');
    return;
  }

  const startTime = Date.now();
  keepAliveStats.totalPings++;
  keepAliveStats.lastPing = new Date().toISOString();

  console.log(`🚀 Enviando self-ping #${keepAliveStats.totalPings} a ${RENDER_URL}/ping`);

  const req = https.get(`${RENDER_URL}/ping`, { timeout: 10000 }, (res) => {
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

// Configurar tareas cron
function setupCronJobs() {
  // Tarea principal: Keep-alive cada 14 minutos
  cron.schedule('*/14 * * * *', () => {
    console.log('⏰ Ejecutando tarea cron: Keep-alive automático');
    performSelfPing();
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  // Tarea secundaria: Ping adicional cada 10 minutos (redundancia)
  cron.schedule('*/10 * * * *', () => {
    console.log('⏰ Ejecutando tarea cron: Ping de respaldo');
    performSelfPing();
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  // Tarea de limpieza: Cada hora, limpiar mensajes antiguos
  cron.schedule('0 * * * *', () => {
    console.log('⏰ Ejecutando tarea cron: Limpieza de mensajes');
    
    // Mantener solo los últimos 50 mensajes en memoria
    if (messages.length > 50) {
      const oldLength = messages.length;
      messages = messages.slice(0, 50);
      console.log(`🧹 Limpieza completada: ${oldLength} -> ${messages.length} mensajes`);
      saveMessages();
    }

    // Resetear estadísticas si han pasado muchos pings
    if (keepAliveStats.totalPings > 1000) {
      console.log('🔄 Reseteando estadísticas de keep-alive');
      keepAliveStats = {
        totalPings: 0,
        successfulPings: 0,
        failedPings: 0,
        lastPing: null,
        lastSuccess: null
      };
    }
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  // Tarea de diagnóstico: Cada 6 horas, mostrar estadísticas
  cron.schedule('0 */6 * * *', () => {
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    console.log('📊 === REPORTE DE ESTADÍSTICAS ===');
    console.log(`⏱️ Uptime: ${hours}h ${minutes}m`);
    console.log(`📱 WhatsApp: ${isConnected ? 'Conectado' : 'Desconectado'}`);
    console.log(`💬 Mensajes en memoria: ${messages.length}`);
    console.log(`🔄 Reintentos de conexión: ${reconnectAttempts}`);
    console.log(`🏓 Keep-alive - Total: ${keepAliveStats.totalPings}, Exitosos: ${keepAliveStats.successfulPings}, Fallidos: ${keepAliveStats.failedPings}`);
    console.log(`🌐 URL de Render: ${RENDER_URL || 'No configurada'}`);
    console.log('================================');
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });

  console.log('⏰ Tareas cron configuradas:');
  console.log('   - Keep-alive principal: cada 14 minutos');
  console.log('   - Keep-alive respaldo: cada 10 minutos');
  console.log('   - Limpieza de mensajes: cada hora');
  console.log('   - Reporte de estadísticas: cada 6 horas');
}

// Función para cargar mensajes persistidos
function loadMessages() {
  try {
    if (fs.existsSync('messages.json')) {
      const data = fs.readFileSync('messages.json', 'utf8');
      messages = JSON.parse(data);
      console.log(`Cargados ${messages.length} mensajes del archivo`);
    }
  } catch (error) {
    console.error('Error cargando mensajes:', error);
    messages = [];
  }
}

// Función para guardar mensajes
function saveMessages() {
  try {
    // Solo guardar los últimos 50 mensajes para evitar archivos muy grandes
    const messagesToSave = messages.slice(0, 50);
    fs.writeFileSync('messages.json', JSON.stringify(messagesToSave, null, 2));
  } catch (error) {
    console.error('Error guardando mensajes:', error);
  }
}

// Función para limpiar archivos de autenticación corruptos
function cleanAuthFiles() {
  try {
    const authDir = 'auth_info_baileys';
    if (fs.existsSync(authDir)) {
      const files = fs.readdirSync(authDir);
      if (files.length > 0 && reconnectAttempts > 5) {
        console.log('Limpiando archivos de autenticación corruptos...');
        fs.rmSync(authDir, { recursive: true, force: true });
        reconnectAttempts = 0;
      }
    }
  } catch (error) {
    console.error('Error limpiando archivos de auth:', error);
  }
}

// Función para conectar WhatsApp
async function connectToWhatsApp() {
  try {
    if (reconnectAttempts > 5) {
      cleanAuthFiles();
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger,
      browser: ["WhatsApp Web", "Desktop", "2.2412.54"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      getMessage: async (key) => {
        return undefined;
      }
    });

    // Eventos de conexión (mantener código existente)
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          io.emit('qr', qrCodeData);
          console.log('QR Code generado - Intento:', reconnectAttempts + 1);
        } catch (err) {
          console.error('Error generando QR:', err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        const reason = lastDisconnect?.error?.output?.statusCode;
        
        console.log('Conexión cerrada. Razón:', reason, 'Reconectar:', shouldReconnect);
        
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          
          console.log(`Reintentando conexión en ${delay/1000}s (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          
          setTimeout(() => {
            connectToWhatsApp();
          }, delay);
        } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.log('Máximo de reintentos alcanzado. Limpiando y reiniciando...');
          cleanAuthFiles();
          reconnectAttempts = 0;
          setTimeout(() => {
            connectToWhatsApp();
          }, 10000);
        }
        
        isConnected = false;
        io.emit('connection-status', { connected: false, reconnecting: shouldReconnect });
      } else if (connection === 'open') {
        console.log('¡WhatsApp conectado exitosamente!');
        isConnected = true;
        qrCodeData = null;
        reconnectAttempts = 0;
        io.emit('connection-status', { connected: true, reconnecting: false });
        io.emit('qr', null);
        
        try {
          await saveCreds();
          console.log('Credenciales guardadas exitosamente');
        } catch (error) {
          console.error('Error guardando credenciales:', error);
        }
      } else if (connection === 'connecting') {
        console.log('Conectando a WhatsApp...');
        io.emit('connection-status', { connected: false, reconnecting: true });
      }
    });

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        console.log('Credenciales actualizadas');
      } catch (error) {
        console.error('Error actualizando credenciales:', error);
      }
    });

    // Manejar mensajes entrantes (mantener código existente)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        
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
          
          if (messages.length % 10 === 0) {
            saveMessages();
          }
          
          io.emit('new-message', messageData);
          console.log(`Mensaje recibido de ${contactName}: ${messageText}`);
          
          if (messageText.toLowerCase().includes('hola jairo')) {
            try {
              if (sock && isConnected) {
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
                console.log(`Respuesta enviada a ${contactName}`);
                
                saveMessages();
              } else {
                console.log('Socket no conectado, no se puede enviar mensaje');
              }
            } catch (error) {
              console.error('Error enviando mensaje:', error);
              if (error.message.includes('Connection Closed') || error.message.includes('Socket')) {
                console.log('Error de conexión detectado, reintentando...');
                isConnected = false;
                connectToWhatsApp();
              }
            }
          }
        }
      } catch (error) {
        console.error('Error procesando mensaje:', error);
      }
    });

  } catch (error) {
    console.error('Error conectando a WhatsApp:', error);
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(() => {
        connectToWhatsApp();
      }, 5000);
    }
  }
}

// Socket.IO para la interfaz web
io.on('connection', (socket) => {
  console.log('Cliente conectado a la interfaz web');
  
  socket.emit('connection-status', { connected: isConnected });
  socket.emit('messages-history', messages);
  
  if (qrCodeData) {
    socket.emit('qr', qrCodeData);
  }
  
  socket.on('disconnect', () => {
    console.log('Cliente desconectado de la interfaz web');
  });
});

// Inicializar aplicación
async function initApp() {
  console.log('🚀 Iniciando WhatsApp Bot con node-cron');
  console.log(`🌐 URL de Render: ${RENDER_URL || 'No detectada automáticamente'}`);
  
  // Cargar mensajes guardados
  loadMessages();
  
  // Configurar tareas cron
  setupCronJobs();
  
  // Iniciar servidor
  server.listen(PORT, () => {
    console.log(`✅ Servidor ejecutándose en puerto ${PORT}`);
    console.log(`💚 Salud del servidor: http://localhost:${PORT}/health`);
    console.log(`🏓 Endpoint de ping: http://localhost:${PORT}/ping`);
    
    connectToWhatsApp();
    
    // Realizar primer ping después de 2 minutos
    if (RENDER_URL) {
      setTimeout(() => {
        console.log('🎯 Realizando primer self-ping...');
        performSelfPing();
      }, 120000);
    }
  });
}

// Manejo de cierre graceful
process.on('SIGINT', async () => {
  console.log('Cerrando aplicación...');
  saveMessages();
  
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      console.error('Error cerrando socket:', error);
    }
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Recibida señal SIGTERM, cerrando...');
  saveMessages();
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      console.error('Error cerrando socket:', error);
    }
  }
  process.exit(0);
});

// Keep-alive simple como respaldo (reducido porque ya tenemos cron)
setInterval(() => {
  const status = {
    timestamp: new Date().toISOString(),
    connected: isConnected,
    uptime: Math.floor(process.uptime()),
    messages: messages.length,
    keepAlive: keepAliveStats
  };
  console.log('💓 Heartbeat:', JSON.stringify(status));
}, 60000); // Cada minuto, menos frecuente

// Iniciar aplicación
initApp();
