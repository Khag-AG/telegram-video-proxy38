const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Директории
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

// Временное хранилище клиентов (только в памяти)
const activeClients = new Map();

// Шифрование/дешифрование
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc', 
    Buffer.from(ENCRYPTION_KEY.slice(0, 32)), 
    iv
  );
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc', 
    Buffer.from(ENCRYPTION_KEY.slice(0, 32)), 
    iv
  );
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// Создание временного токена доступа
function createAccessToken(sessionString) {
  const payload = {
    session: sessionString,
    exp: Date.now() + (5 * 60 * 1000) // 5 минут
  };
  return encrypt(JSON.stringify(payload));
}

// Проверка и получение сессии из токена
function getSessionFromToken(token) {
  try {
    const decrypted = decrypt(token);
    const payload = JSON.parse(decrypted);
    
    if (Date.now() > payload.exp) {
      throw new Error('Токен истек');
    }
    
    return payload.session;
  } catch (error) {
    throw new Error('Неверный токен');
  }
}

// Эндпоинт для создания временного токена
app.post('/create-token', async (req, res) => {
  try {
    const { sessionString } = req.body;
    
    if (!sessionString || sessionString.length < 400) {
      return res.status(400).json({ 
        error: 'Неверная строка сессии' 
      });
    }
    
    // Создаем временный токен
    const token = createAccessToken(sessionString);
    
    res.json({
      token: token,
      expiresIn: '5 minutes'
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Основной эндпоинт для загрузки
app.post('/download-secure', async (req, res) => {
  let client = null;
  const clientId = uuidv4();
  
  try {
    const { token, channelUsername, fileName, fileSize } = req.body;
    
    if (!token) {
      return res.status(400).json({ 
        error: 'Токен не предоставлен' 
      });
    }
    
    // Получаем сессию из токена
    const sessionString = getSessionFromToken(token);
    
    console.log(`[Secure] Загрузка ${fileName} из ${channelUsername}`);
    
    // Создаем клиент
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    
    client = new TelegramClient(
      new StringSession(sessionString),
      apiId,
      apiHash,
      { connectionRetries: 3 }
    );
    
    activeClients.set(clientId, client);
    await client.connect();
    
    // Получаем канал
    const cleanUsername = channelUsername.replace('@', '');
    const channel = await client.getEntity(cleanUsername);
    
    // Ищем видео
    const messages = await client.getMessages(channel, { limit: 50 });
    
    let targetMessage = null;
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attrs = message.media.document.attributes || [];
        const fileAttr = attrs.find(attr => attr.fileName === fileName);
        if (fileAttr) {
          targetMessage = message;
          break;
        }
      }
    }
    
    if (!targetMessage) {
      return res.status(404).json({ error: 'Видео не найдено' });
    }
    
    // Загружаем файл
    const uploadId = uuidv4();
    const localPath = path.join(uploadDir, `${uploadId}.mp4`);
    
    await client.downloadMedia(targetMessage, {
      outputFile: localPath,
      progressCallback: (received, total) => {
        const percent = Math.round((received / total) * 100);
        if (percent % 20 === 0) {
          console.log(`[Secure] Прогресс: ${percent}%`);
        }
      }
    });
    
    const stats = await fs.stat(localPath);
    
    // Для файлов меньше 95MB - возвращаем напрямую
    if (stats.size < 95 * 1024 * 1024) {
      const fileBuffer = await fs.readFile(localPath);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(fileBuffer);
      
      // Удаляем файл
      setTimeout(() => {
        fs.unlink(localPath).catch(() => {});
      }, 5000);
    } else {
      // Для больших файлов - возвращаем ссылку
      const downloadToken = encrypt(JSON.stringify({
        uploadId: uploadId,
        fileName: fileName,
        exp: Date.now() + (15 * 60 * 1000) // 15 минут
      }));
      
      res.json({
        success: true,
        fileName: fileName,
        fileSize: stats.size,
        downloadToken: downloadToken,
        downloadUrl: `https://${req.get('host')}/download-file/${downloadToken}`
      });
    }
    
  } catch (error) {
    console.error('[Secure] Ошибка:', error);
    res.status(500).json({ 
      error: 'Ошибка обработки',
      details: error.message 
    });
  } finally {
    // Всегда отключаем клиент
    if (client) {
      try {
        await client.disconnect();
      } catch (e) {}
      activeClients.delete(clientId);
    }
  }
});

// Эндпоинт для скачивания больших файлов
app.get('/download-file/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    // Расшифровываем токен
    const data = JSON.parse(decrypt(token));
    
    if (Date.now() > data.exp) {
      return res.status(403).json({ error: 'Ссылка истекла' });
    }
    
    const filePath = path.join(uploadDir, `${data.uploadId}.mp4`);
    const stats = await fs.stat(filePath);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${data.fileName}"`);
    
    const stream = require('fs').createReadStream(filePath);
    stream.pipe(res);
    
    // Удаляем после отправки
    stream.on('end', () => {
      setTimeout(() => {
        fs.unlink(filePath).catch(() => {});
      }, 5000);
    });
    
  } catch (error) {
    res.status(404).json({ error: 'Файл не найден' });
  }
});

// Очистка
setInterval(async () => {
  // Отключаем неактивные клиенты
  for (const [id, client] of activeClients) {
    if (!client.connected) {
      activeClients.delete(id);
    }
  }
  
  // Удаляем старые файлы
  try {
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtimeMs > 30 * 60 * 1000) { // 30 минут
        await fs.unlink(filePath);
        console.log(`Удален старый файл: ${file}`);
      }
    }
  } catch (error) {}
}, 5 * 60 * 1000); // каждые 5 минут

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    server: 'Telegram Video Proxy',
    version: '3.0.0'
  });
});

// Health check для Railway
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.listen(PORT, () => {
  console.log(`\n🔒 Защищенный сервер запущен на порту ${PORT}`);
  console.log(`\nКлюч шифрования: ${ENCRYPTION_KEY.substring(0, 10)}...`);
});