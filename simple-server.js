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
      
      // Кодируем имя файла для безопасной передачи
      const encodedFileName = encodeURIComponent(fileName).replace(/'/g, "%27");

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFileName}`);
      res.setHeader('X-Upload-Id', uniqueId);
      res.setHeader('X-File-Name', encodedFileName);
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

// Специальный эндпоинт для Make.com с поддержкой больших файлов
app.post('/make-integration', async (req, res) => {
  try {
    const { channelUsername, fileName, fileSize, action = 'download' } = req.body;
    
    if (!telegramClient) {
      telegramClient = await initClient();
      if (!telegramClient) {
        return res.status(500).json({ error: 'Не удалось подключиться к Telegram' });
      }
    }
    
    // Если запрос на проверку статуса файла
    if (action === 'check') {
      const { uploadId } = req.body;
      const filePath = path.join(uploadDir, `${uploadId}.mp4`);
      
      try {
        const stats = await fs.stat(filePath);
        return res.json({
          status: 'ready',
          uploadId: uploadId,
          fileSize: stats.size,
          expiresIn: '15 minutes'
        });
      } catch (err) {
        return res.json({ status: 'not_found' });
      }
    }
    
    console.log(`[Make Integration] Загружаем ${fileName} из ${channelUsername}`);
    
    // Получаем канал
    const channel = await telegramClient.getEntity(channelUsername);
    
    // Ищем видео - сначала получаем последние сообщения без поиска
    const messages = await telegramClient.getMessages(channel, { 
      limit: 100  // Увеличиваем лимит для поиска
    });

    console.log(`[Make Integration] Проверяем ${messages.length} сообщений`);
    
    let targetMessage = null;
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attrs = message.media.document.attributes || [];
        
        // Проверяем каждый атрибут
        for (const attr of attrs) {
          if (attr.fileName) {
            console.log(`[Make Integration] Найден файл: ${attr.fileName}`);
            
            // Сравниваем имена файлов
            if (attr.fileName === fileName || 
                attr.fileName.toLowerCase() === fileName.toLowerCase()) {
              targetMessage = message;
              break;
            }
          }
        }
        
        // Если нашли по имени - выходим
        if (targetMessage) break;
        
        // Если не нашли по имени, но есть размер - проверяем по размеру
        if (!targetMessage && fileSize && message.media.document.size) {
          const sizeDiff = Math.abs(message.media.document.size - fileSize);
          if (sizeDiff < 1000) { // Разница меньше 1KB
            console.log(`[Make Integration] Найден файл по размеру: ${message.media.document.size} байт`);
            targetMessage = message;
            break;
          }
        }
      }
    }
    
    if (!targetMessage) {
      return res.status(404).json({ error: 'Видео не найдено в канале' });
    }
    
    // Генерируем уникальный ID
    const uploadId = uuidv4();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const localPath = path.join(uploadDir, `${uploadId}.mp4`);
    
    console.log(`[Make Integration] Начинаем загрузку...`);
    
    // Загружаем файл
    await telegramClient.downloadMedia(targetMessage, {
      outputFile: localPath,
      progressCallback: (received, total) => {
        const percent = Math.round((received / total) * 100);
        if (percent % 10 === 0) {
          console.log(`[Make Integration] Прогресс: ${percent}% (${Math.round(received / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`);
        }
      }
    });
    
    const stats = await fs.stat(localPath);
    console.log(`[Make Integration] Загружено: ${Math.round(stats.size / 1024 / 1024)}MB`);
    
    // Планируем удаление через 15 минут
    setTimeout(async () => {
      try {
        await fs.unlink(localPath);
        console.log(`[Make Integration] Файл удален: ${uploadId}`);
      } catch (err) {
        // Файл уже удален
      }
    }, 15 * 60 * 1000); // 15 минут
    
    // Возвращаем информацию о файле
    const baseUrl = `https://${req.get('host')}`;
    
    // ИСПРАВЛЕНО: Читаем файл и конвертируем в hex для Make.com
    let binaryData = null;
    let hexData = null;
    let isChunked = false;
    let chunks = [];
    
    try {
      const fileBuffer = await fs.readFile(localPath);
      
      // Если файл меньше 95MB - возвращаем как hex
      if (stats.size < 95 * 1024 * 1024) {
        // Конвертируем в hex формат для Make.com
        hexData = fileBuffer.toString('hex').match(/.{1,2}/g).join(' ');
        console.log(`[Make Integration] Добавлены бинарные данные (hex): ${Math.round(hexData.length / 1024)}KB`);
      } else {
        // Для больших файлов - разбиваем на чанки по 30MB
        isChunked = true;
        const chunkSize = 30 * 1024 * 1024; // 30MB чанки
        const totalChunks = Math.ceil(fileBuffer.length / chunkSize);
        
        console.log(`[Make Integration] Файл большой (${Math.round(stats.size / 1024 / 1024)}MB), разбиваем на ${totalChunks} чанков`);
        
        for (let i = 0; i < totalChunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, fileBuffer.length);
          const chunk = fileBuffer.slice(start, end);
          const chunkHex = chunk.toString('hex').match(/.{1,2}/g).join(' ');
          
          chunks.push({
            index: i,
            data: chunkHex,
            size: chunk.length,
            sizeHex: chunkHex.length
          });
          
          console.log(`[Make Integration] Чанк ${i + 1}/${totalChunks}: ${Math.round(chunk.length / 1024 / 1024)}MB`);
        }
      }
    } catch (error) {
      console.error(`[Make Integration] Ошибка чтения файла для hex:`, error);
    }
    
    res.json({
      success: true,
      uploadId: uploadId,
      fileName: safeFileName,
      originalFileName: fileName,
      fileSize: stats.size,
      fileSizeMB: Math.round(stats.size / 1024 / 1024),
      mimeType: 'video/mp4',
      
      // Прямые ссылки для скачивания
      downloadUrl: `${baseUrl}/file/${uploadId}`,
      streamUrl: `${baseUrl}/stream/${uploadId}`,
      
      // Специальные URL для интеграций
      directUrl: `${baseUrl}/direct/${uploadId}/${safeFileName}`,
      publicUrl: `${baseUrl}/public/${uploadId}.mp4`,
      
      // ИСПРАВЛЕНО: Бинарные данные в hex формате для Make.com
      data: hexData, // hex для файлов < 95MB
      dataFormat: 'hex', // указываем формат данных
      hasData: !!hexData,
      
      // ИСПРАВЛЕНО: Для больших файлов - чанки
      isChunked: isChunked,
      chunks: chunks, // Массив с hex чанками для больших файлов
      totalChunks: chunks.length,
      
      // Информация о времени жизни
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      expiresIn: '15 minutes',
      
      // Дополнительная информация
      channelUsername: channelUsername,
      downloadedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Make Integration] Ошибка:', error);
    res.status(500).json({ 
      error: 'Ошибка обработки запроса',
      details: error.message 
    });
  }
});

// НОВЫЙ эндпоинт для Make.com - возвращает бинарные данные напрямую
app.post('/make-binary', async (req, res) => {
  try {
    const { channelUsername, fileName, fileSize } = req.body;
    
    if (!telegramClient) {
      telegramClient = await initClient();
      if (!telegramClient) {
        return res.status(500).json({ error: 'Не удалось подключиться к Telegram' });
      }
    }
    
    console.log(`[Make Binary] Загружаем ${fileName} из ${channelUsername}`);
    
    // Получаем канал
    const channel = await telegramClient.getEntity(channelUsername);
    
    // Ищем видео
    const messages = await telegramClient.getMessages(channel, { limit: 100 });
    
    let targetMessage = null;
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attrs = message.media.document.attributes || [];
        for (const attr of attrs) {
          if (attr.fileName && attr.fileName === fileName) {
            targetMessage = message;
            break;
          }
        }
        if (targetMessage) break;
      }
    }
    
    if (!targetMessage) {
      return res.status(404).json({ error: 'Видео не найдено' });
    }
    
    // Загружаем в буфер напрямую (без сохранения на диск)
    console.log(`[Make Binary] Загружаем в память...`);
    
    const buffer = await telegramClient.downloadMedia(targetMessage, {
      progressCallback: (r, t) => {
        const percent = Math.round((r / t) * 100);
        if (percent % 20 === 0) console.log(`[Make Binary] Прогресс: ${percent}%`);
      }
    });
    
    console.log(`[Make Binary] Загружено ${buffer.length} байт`);
    
    // Отправляем как бинарные данные
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    
  } catch (error) {
    console.error('[Make Binary] Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// Прямая ссылка с правильным именем файла
app.get('/direct/:uploadId/:filename', async (req, res) => {
  try {
    const { uploadId, filename } = req.params;
    const filePath = path.join(uploadDir, `${uploadId}.mp4`);
    
    const stats = await fs.stat(filePath);
    
    // Отправляем с правильными заголовками для соцсетей
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=900'); // Кэш на 15 минут
    
    // Поддержка Range запросов для больших файлов
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      res.setHeader('Content-Length', chunksize);
      
      const stream = require('fs').createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      const stream = require('fs').createReadStream(filePath);
      stream.pipe(res);
    }
    
  } catch (error) {
    res.status(404).json({ error: 'Файл не найден' });
  }
});

// Публичная ссылка для соцсетей
app.get('/public/:filename', async (req, res) => {
  try {
    const uploadId = req.params.filename.replace('.mp4', '');
    const filePath = path.join(uploadDir, `${uploadId}.mp4`);
    
    const stats = await fs.stat(filePath);
    
    // Оптимизированные заголовки для соцсетей
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=900');
    
    // Open Graph meta теги для предпросмотра
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    const stream = require('fs').createReadStream(filePath);
    stream.pipe(res);
    
  } catch (error) {
    res.status(404).send('Video not found');
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