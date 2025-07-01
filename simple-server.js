const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Создаем директории
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

// Единственный клиент Telegram
let telegramClient = null;

// Простая инициализация
async function initClient() {
  try {
    const sessionString = "1AgAOMTQ5LjE1NC4xNjcuNDEBu4XfMtISh2Zg/L/PxmEkQzenXD09bkW5mLqBxRv9KXv+l50N42mRO8dCi0fcCrWsZEapLLaMtNd8mBleKHBuU8O8j2wZpM2JKI70gLoW6gF4x6X0cn7RdqmOcoIFO1NKicBuldvhtHNt7JWNns5Tvkq0BzOtY3zrPMY/iiOQ221mn9cRfxEtbOlabRcrz7ijfzR5f4yAiXEWGi1R5gmQ9rQXzZtyMgWAA7dbSW2jvnNR4Ob+tnEk/ccPovox3RSoawIPDH47+RazFSZTfzqKyEFw6EZBXw9UO+M5WVUJKcxasimgW+HmGgY9oG6WZ2uee/ly4S4ejG8mb8kJ5/Znlpg=";
    
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    
    const client = new TelegramClient(
      new StringSession(sessionString), 
      apiId, 
      apiHash, 
      { connectionRetries: 5 }
    );
    
    await client.connect();
    console.log('Telegram подключен!');
    return client;
  } catch (error) {
    console.error('Ошибка подключения:', error);
    return null;
  }
}

// Простой эндпоинт для загрузки
app.post('/download-video', async (req, res) => {
  try {
    const { channelUsername, fileName, fileSize } = req.body;
    
    if (!telegramClient) {
      telegramClient = await initClient();
      if (!telegramClient) {
        return res.status(500).json({ error: 'Не удалось подключиться к Telegram' });
      }
    }
    
    console.log(`Загружаем ${fileName} из ${channelUsername}`);
    
    // Получаем канал
    const channel = await telegramClient.getEntity(channelUsername);
    
    // Ищем видео
    const messages = await telegramClient.getMessages(channel, { limit: 30 });
    
    let targetMessage = null;
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attrs = message.media.document.attributes || [];
        if (attrs.some(a => a.fileName === fileName)) {
          targetMessage = message;
          break;
        }
      }
    }
    
    if (!targetMessage) {
      return res.status(404).json({ error: 'Видео не найдено' });
    }
    
    // Загружаем
    const uniqueId = uuidv4();
    const localPath = path.join(uploadDir, `${uniqueId}.mp4`);
    
    await telegramClient.downloadMedia(targetMessage, {
      outputFile: localPath,
      progressCallback: (r, t) => {
        const percent = Math.round((r / t) * 100);
        if (percent % 20 === 0) console.log(`Прогресс: ${percent}%`);
      }
    });
    
    const stats = await fs.stat(localPath);
    
    res.json({
      success: true,
      uploadId: uniqueId,
      size: stats.size,
      downloadUrl: `https://${req.get('host')}/file/${uniqueId}`
    });
    
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// Получение файла
app.get('/file/:uploadId', async (req, res) => {
  try {
    const filePath = path.join(uploadDir, `${req.params.uploadId}.mp4`);
    
    const stats = await fs.stat(filePath);
    
    // Отправляем правильные заголовки для YouTube
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', 'inline; filename="video.mp4"');
    res.setHeader('Accept-Ranges', 'bytes');
    
    const stream = require('fs').createReadStream(filePath);
    stream.pipe(res);
    
    stream.on('end', () => {
      setTimeout(() => {
        fs.unlink(filePath).catch(() => {});
      }, 300000); // 300 секунд = 5 минут
    });
    
  } catch (error) {
    res.status(404).json({ error: 'Файл не найден' });
  }
});

// Проверка
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    connected: !!telegramClient
  });
});

// Специальный эндпоинт для Make.com - всё в одном
app.post('/make-download-video', async (req, res) => {
  try {
    const { channelUsername, fileName, fileSize, returnBinary = false } = req.body;
    
    if (!telegramClient) {
      telegramClient = await initClient();
      if (!telegramClient) {
        return res.status(500).json({ error: 'Не удалось подключиться к Telegram' });
      }
    }
    
    console.log(`[Make.com] Загружаем ${fileName} из ${channelUsername}`);
    
    // Получаем канал
    const channel = await telegramClient.getEntity(channelUsername);
    
    // Ищем видео
    const messages = await telegramClient.getMessages(channel, { limit: 30 });
    
    let targetMessage = null;
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attrs = message.media.document.attributes || [];
        if (attrs.some(a => a.fileName === fileName)) {
          targetMessage = message;
          break;
        }
      }
    }
    
    if (!targetMessage) {
      return res.status(404).json({ error: 'Видео не найдено' });
    }
    
    // Загружаем
    const uniqueId = uuidv4();
    const localPath = path.join(uploadDir, `${uniqueId}.mp4`);
    
    await telegramClient.downloadMedia(targetMessage, {
      outputFile: localPath,
      progressCallback: (r, t) => {
        const percent = Math.round((r / t) * 100);
        if (percent % 20 === 0) console.log(`[Make.com] Прогресс: ${percent}%`);
      }
    });
    
    const stats = await fs.stat(localPath);
    
    // Создаём ответ в зависимости от размера файла
    const response = {
      success: true,
      uploadId: uniqueId,
      fileName: fileName,
      fileSize: stats.size,
      mimeType: 'video/mp4'
    };
    
    // Для файлов меньше 95MB - можем вернуть данные напрямую
    if (stats.size < 95 * 1024 * 1024 && returnBinary) {
      const fileBuffer = await fs.readFile(localPath);
      
      // Возвращаем бинарные данные напрямую
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      res.setHeader('X-Upload-Id', uniqueId);
      res.setHeader('X-File-Size', stats.size);
      res.send(fileBuffer);
      
      // Удаляем файл через 10 секунд
      setTimeout(() => {
        fs.unlink(localPath).catch(() => {});
      }, 10000);
      
    } else {
      // Для больших файлов - возвращаем URL для скачивания
      response.downloadUrl = `https://${req.get('host')}/file/${uniqueId}`;
      response.streamUrl = `https://${req.get('host')}/stream/${uniqueId}`;
      response.requiresChunking = stats.size > 95 * 1024 * 1024;
      
      // Если нужны чанки
      if (response.requiresChunking) {
        const chunkSize = 5 * 1024 * 1024; // 5MB чанки
        response.chunks = {
          size: chunkSize,
          total: Math.ceil(stats.size / chunkSize),
          urls: []
        };
        
        // Генерируем URLs для каждого чанка
        for (let i = 0; i < response.chunks.total; i++) {
          response.chunks.urls.push({
            index: i,
            url: `https://${req.get('host')}/chunk/${uniqueId}/${i}`,
            start: i * chunkSize,
            end: Math.min((i + 1) * chunkSize, stats.size)
          });
        }
      }
      
      res.json(response);
    }
    
  } catch (error) {
    console.error('[Make.com] Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// Эндпоинт для получения чанков
app.get('/chunk/:uploadId/:index', async (req, res) => {
  try {
    const { uploadId, index } = req.params;
    const chunkIndex = parseInt(index);
    const filePath = path.join(uploadDir, `${uploadId}.mp4`);
    
    const stats = await fs.stat(filePath);
    const chunkSize = 5 * 1024 * 1024; // 5MB
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize - 1, stats.size - 1);
    
    if (start >= stats.size) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    
    const stream = require('fs').createReadStream(filePath, { start, end });
    stream.pipe(res);
    
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

// Поддерживаем активность для Railway
setInterval(() => {
  console.log('Keep alive:', new Date().toISOString());
}, 30000); // каждые 30 секунд

// Запуск
app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  telegramClient = await initClient();
});