const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino');
const path = require('path');

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

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Función para conectar WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: logger,
    browser: ["WhatsApp Bot", "Desktop", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  // Manejar eventos de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      try {
        qrCodeData = await QRCode.toDataURL(qr);
        io.emit('qr', qrCodeData);
        console.log('QR Code generado');
      } catch (err) {
        console.error('Error generando QR:', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada debido a ', lastDisconnect?.error, ', reconectando ', shouldReconnect);
      
      if (shouldReconnect) {
        setTimeout(() => {
          connectToWhatsApp();
        }, 5000);
      }
      
      isConnected = false;
      io.emit('connection-status', { connected: false });
    } else if (connection === 'open') {
      console.log('¡WhatsApp conectado exitosamente!');
      isConnected = true;
      qrCodeData = null;
      io.emit('connection-status', { connected: true });
      io.emit('qr', null);
    }
  });

  // Guardar credenciales cuando se actualicen
  sock.ev.on('creds.update', saveCreds);

  // Manejar mensajes entrantes
  sock.ev.on('messages.upsert', async (m) => {
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
      if (messages.length > 100) messages.pop(); // Mantener solo 100 mensajes
      
      io.emit('new-message', messageData);
      console.log(`Mensaje recibido de ${contactName}: ${messageText}`);
      
      // Responder a "hola jairo"
      if (messageText.toLowerCase().includes('hola jairo')) {
        try {
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
        } catch (error) {
          console.error('Error enviando mensaje:', error);
        }
      }
    }
  });
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

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`Servidor ejecutándose en puerto ${PORT}`);
  connectToWhatsApp();
});

// Mantener el proceso activo
process.on('SIGINT', () => {
  console.log('Cerrando aplicación...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

// Ping cada 25 segundos para mantener activo en Render
setInterval(() => {
  console.log('Keep-alive ping:', new Date().toISOString());
}, 25000);
