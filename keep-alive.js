// keep-alive.js
// Script para ejecutar externamente y mantener tu bot activo en Render

const https = require('https');

// Cambia esta URL por la URL de tu aplicación en Render
const APP_URL = 'https://tu-app-name.onrender.com'; // Reemplaza con tu URL real

// Configuración
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutos (antes de que se duerma)
const RETRY_INTERVAL = 2 * 60 * 1000; // 2 minutos si hay error

let pingCount = 0;
let errorCount = 0;

function pingApp() {
  const startTime = Date.now();
  
  console.log(`[${new Date().toISOString()}] Enviando ping #${++pingCount} a ${APP_URL}/health`);
  
  const req = https.get(`${APP_URL}/health`, { timeout: 10000 }, (res) => {
    const responseTime = Date.now() - startTime;
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        console.log(`✅ Ping exitoso (${responseTime}ms) - Estado: ${response.status}, WhatsApp: ${response.connected ? 'Conectado' : 'Desconectado'}, Uptime: ${Math.floor(response.uptime)}s`);
        errorCount = 0; // Reset contador de errores
        
        // Programar siguiente ping
        setTimeout(pingApp, PING_INTERVAL);
      } catch (error) {
        console.log(`⚠️ Respuesta recibida pero no es JSON válido: ${data}`);
        scheduleRetry();
      }
    });
  });
  
  req.on('timeout', () => {
    console.log(`⏰ Timeout en ping #${pingCount}`);
    req.destroy();
    scheduleRetry();
  });
  
  req.on('error', (error) => {
    console.log(`❌ Error en ping #${pingCount}:`, error.message);
    scheduleRetry();
  });
}

function scheduleRetry() {
  errorCount++;
  const nextPing = errorCount > 3 ? PING_INTERVAL : RETRY_INTERVAL;
  console.log(`🔄 Reintentando en ${nextPing/1000/60} minutos (errores consecutivos: ${errorCount})`);
  setTimeout(pingApp, nextPing);
}

// Mensaje de inicio
console.log('🚀 Iniciando Keep-Alive para WhatsApp Bot');
console.log(`📍 URL objetivo: ${APP_URL}`);
console.log(`⏱️ Intervalo de ping: ${PING_INTERVAL/1000/60} minutos`);
console.log('─'.repeat(80));

// Validar URL
if (APP_URL === 'https://tu-app-name.onrender.com') {
  console.log('⚠️ ADVERTENCIA: Necesitas cambiar APP_URL por la URL real de tu aplicación en Render');
  console.log('   Ejemplo: https://whatsapp-bot-jairo-abc123.onrender.com');
  process.exit(1);
}

// Comenzar pings
pingApp();

// Manejo de señales para cierre limpio
process.on('SIGINT', () => {
  console.log('\n🛑 Deteniendo Keep-Alive...');
  console.log(`📊 Estadísticas finales: ${pingCount} pings enviados, ${errorCount} errores`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Recibida señal SIGTERM, cerrando...');
  process.exit(0);
});

// Log cada hora para mostrar que sigue activo
setInterval(() => {
  const hours = Math.floor(process.uptime() / 3600);
  const minutes = Math.floor((process.uptime() % 3600) / 60);
  console.log(`📊 Keep-Alive activo por ${hours}h ${minutes}m - Pings: ${pingCount}, Errores: ${errorCount}`);
}, 60 * 60 * 1000);
