# API Test Documentation

## Nuevo Endpoint: POST /send-message

### Autenticación
```
Authorization: Bearer envios_whatsapp_recordatorios_vacuna2025
```

### Ejemplo de Request
```bash
curl -X POST http://localhost:3000/send-message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer envios_whatsapp_recordatorios_vacuna2025" \
  -d '{
    "phone": "573001234567",
    "message": "Hola desde la API de Vacun.org"
  }'
```

### Respuestas Esperadas

#### Éxito (200)
```json
{
  "success": true
}
```

#### Error de Autenticación (401)
```json
{
  "success": false,
  "error": "Unauthorized"
}
```

#### WhatsApp Desconectado (503)
```json
{
  "success": false,
  "error": "WhatsApp not connected"
}
```

#### Datos Inválidos (400)
```json
{
  "success": false,
  "error": "Phone and message are required"
}
```

### Endpoint de Salud Actualizado
```bash
curl http://localhost:3000/health
```

Respuesta:
```json
{
  "success": true,
  "connected": true,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### Rate Limiting
- Máximo 30 peticiones por minuto por IP
- Respuesta cuando se excede el límite:
```json
{
  "success": false,
  "error": "Too many requests, please try again later"
}
```

### Variables de Entorno Requeridas
```
BOT_API_KEY=envios_whatsapp_recordatorios_vacuna2025
PORT=3000
```
