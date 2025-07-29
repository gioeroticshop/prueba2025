const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Logger
const logger = P({ level: 'silent' });

// Variables globales
let sock;
let qrCodeData = null;
let isConnected = false;
let messages = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint de salud para el keep-alive externo
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: isConnected, 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

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
      // Si hay archivos pero la conexión falla repetidamente, limpiar
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

// Función para conectar WhatsApp con reintentos mejorados
async function connectToWhatsApp() {
  try {
    // Limpiar archivos corruptos si es necesario
    if (reconnectAttempts > 5) {
      cleanAuthFiles();
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger,
      browser: ["WhatsApp Bot", "Desktop", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000, // 60 segundos de timeout
      defaultQueryTimeoutMs: 60000,
      // Configuraciones adicionales para mejorar la estabilidad
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      // Reducir la carga de sincronización
      getMessage: async (key) => {
        return undefined; // No guardar mensajes en caché
      }
    });

    // Manejar eventos de conexión
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
          const delay = Math.min(5000 * reconnectAttempts, 30000); // Delay incremental, máximo 30s
          
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
        reconnectAttempts = 0; // Reset contador de reintentos
        io.emit('connection-status', { connected: true, reconnecting: false });
        io.emit('qr', null);
        
        // Guardar credenciales inmediatamente después de conectar
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

    // Guardar credenciales cuando se actualicen
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        console.log('Credenciales actualizadas');
      } catch (error) {
        console.error('Error actualizando credenciales:', error);
      }
    });

    // Manejar mensajes entrantes con mejor manejo de errores
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
          
          // Guardar mensajes periódicamente
          if (messages.length % 10 === 0) {
            saveMessages();
          }
          
          io.emit('new-message', messageData);
          console.log(`Mensaje recibido de ${contactName}: ${messageText}`);
          
          // Responder a "hola jairo" con manejo de errores mejorado
          if (messageText.toLowerCase().includes('hola jairo')) {
            try {
              // Verificar que el socket esté conectado antes de enviar
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
                
                // Guardar mensajes después de enviar respuesta
                saveMessages();
              } else {
                console.log('Socket no conectado, no se puede enviar mensaje');
              }
            } catch (error) {
              console.error('Error enviando mensaje:', error);
              // Si el error es de conexión, intentar reconectar
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
  
  // Enviar estado actual
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
  // Cargar mensajes guardados
  loadMessages();
  
  // Iniciar servidor
  server.listen(PORT, () => {
    console.log(`Servidor ejecutándose en puerto ${PORT}`);
    console.log(`Salud del servidor: http://localhost:${PORT}/health`);
    connectToWhatsApp();
  });
}

// Manejo de cierre graceful
process.on('SIGINT', async () => {
  console.log('Cerrando aplicación...');
  
  // Guardar mensajes antes de cerrar
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

// Keep-alive interno mejorado
setInterval(() => {
  const status = {
    timestamp: new Date().toISOString(),
    connected: isConnected,
    uptime: process.uptime(),
    messages: messages.length,
    attempts: reconnectAttempts
  };
  console.log('Keep-alive:', JSON.stringify(status));
}, 25000);

// Iniciar aplicación
initApp();
