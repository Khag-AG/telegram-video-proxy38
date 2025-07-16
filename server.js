const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Настройка CORS и JSON
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Создаем директории
const uploadDir = path.join(__dirname, 'uploads');
const sessionsDir = path.join(__dirname, 'sessions');
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);
fs.mkdir(sessionsDir, { recursive: true }).catch(console.error);

// Хранилище клиентов Telegram
const telegramClients = new Map();

// Функция получения клиента для бота
async function getBotClient(botSessionString) {
  try {
    console.log('Получена строка сессии:', botSessionString ? 'Да' : 'Нет');
    console.log('Длина строки:', botSessionString ? botSessionString.length : 0);
    
    // Проверяем наличие строки сессии
    if (!botSessionString || botSessionString.trim() === '') {
      throw new Error('Строка сессии не предоставлена');
    }
    
    // Убираем лишние пробелы и переносы строк
    const cleanSession = botSessionString.trim();
    
    // Используем хеш сессии как ключ
    const sessionKey = require('crypto').createHash('md5').update(cleanSession).digest('hex');
    
    // Проверяем, есть ли уже активный клиент
    if (telegramClients.has(sessionKey)) {
      const client = telegramClients.get(sessionKey);
      if (client.connected) {
        console.log('Используем существующий клиент');
        return client;
      }
    }

    console.log('Создаем новый клиент...');
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    
    console.log('API ID:', apiId ? 'Установлен' : 'НЕ УСТАНОВЛЕН');
    console.log('API Hash:', apiHash ? 'Установлен' : 'НЕ УСТАНОВЛЕН');
    
    const stringSession = new StringSession(cleanSession);

    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: false
    });

    await client.connect();
    console.log('Клиент подключен успешно');
    
    // Сохраняем клиент
    telegramClients.set(sessionKey, client);
    
    return client;
  } catch (error) {
    console.error('Ошибка создания клиента:', error.message);
    throw error;
  }
}

// Основной эндпоинт для Make.com
app.post('/make-download', async (req, res) => {
  try {
    const { 
      botSession,
      channelUsername, 
      fileName, 
      fileSize 
    } = req.body;
    
    if (!botSession || !channelUsername || !fileName) {
      return res.status(400).json({ 
        error: 'Обязательные параметры: botSession, channelUsername, fileName' 
      });
    }

    console.log(`\n[Make.com] Запрос на загрузку: ${fileName} из ${channelUsername}`);
    
    // Получаем клиент
    const client = await getBotClient(botSession);
    
    // Получаем канал
    let channel;
    try {
      // Убираем @ если есть
      const cleanUsername = channelUsername.replace('@', '');
      channel = await client.getEntity(cleanUsername);
      console.log(`Канал найден: ${channel.title}`);
    } catch (error) {
      console.error('Ошибка получения канала:', error);
      return res.status(404).json({ 
        error: 'Канал не найден',
        details: error.message 
      });
    }
    
    // Ищем сообщение с видео
    console.log('Поиск видео в канале...');
    const messages = await client.getMessages(channel, { 
      limit: 100,
      reverse: false // Сначала новые
    });
    
    let targetMessage = null;
    
    for (const message of messages) {
      if (message.media && message.media.document) {
        const doc = message.media.document;
        const attributes = doc.attributes || [];
        
        // Ищем по имени файла
        const fileAttr = attributes.find(attr => attr.fileName);
        if (fileAttr && fileAttr.fileName === fileName) {
          targetMessage = message;
          console.log(`Найдено видео: ${fileName}`);
          break;
        }
        
        // Если не нашли по имени, проверяем по размеру
        if (!targetMessage && fileSize && doc.size) {
          const sizeDiff = Math.abs(doc.size - fileSize);
          if (sizeDiff < 1000) { // Разница меньше 1KB
            targetMessage = message;
            console.log(`Найдено видео по размеру: ${doc.size} байт`);
            break;
          }
        }
      }
    }

    if (!targetMessage) {
      return res.status(404).json({ 
        error: 'Видео не найдено в канале',
        searched: fileName
      });
    }

    // Генерируем уникальное имя файла
    const uploadId = uuidv4();
    const extension = path.extname(fileName) || '.mp4';
    const localFileName = `${uploadId}${extension}`;
    const localFilePath = path.join(uploadDir, localFileName);

    console.log(`Начинаем загрузку файла...`);
    
    // Загружаем файл
    await client.downloadMedia(targetMessage, {
      outputFile: localFilePath,
      progressCallback: (received, total) => {
        const percent = Math.round((received / total) * 100);
        if (percent % 10 === 0) {
          console.log(`Прогресс: ${percent}% (${Math.round(received / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`);
        }
      }
    });

    const stats = await fs.stat(localFilePath);
    const fileSizeMB = Math.round(stats.size / 1024 / 1024);
    console.log(`Загрузка завершена: ${fileSizeMB}MB`);

    // Читаем файл в буфер для Make.com
    const fileBuffer = await fs.readFile(localFilePath);
    
    // Отправляем файл как бинарные данные
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Upload-Id', uploadId);
    res.setHeader('X-File-Name', fileName);
    res.setHeader('X-File-Size', stats.size);
    
    res.send(fileBuffer);
    
    // Удаляем файл через 5 минут
    setTimeout(async () => {
      try {
        await fs.unlink(localFilePath);
        console.log(`Файл удален: ${localFileName}`);
      } catch (err) {
        // Файл уже удален
      }
    }, 5 * 60 * 1000);

  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ 
      error: 'Ошибка загрузки видео',
      details: error.message 
    });
  }
});

// Эндпоинт для больших файлов (если файл больше 95MB для Make.com)
app.post('/make-download-url', async (req, res) => {
  try {
    const { 
      botSession,
      channelUsername, 
      fileName, 
      fileSize 
    } = req.body;
    
    if (!botSession || !channelUsername || !fileName) {
      return res.status(400).json({ 
        error: 'Обязательные параметры: botSession, channelUsername, fileName' 
      });
    }

    console.log(`\n[Make URL] Запрос на загрузку: ${fileName} из ${channelUsername}`);
    
    // Получаем клиент
    const client = await getBotClient(botSession);
    
    // Получаем канал
    const cleanUsername = channelUsername.replace('@', '');
    const channel = await client.getEntity(cleanUsername);
    
    // Ищем видео
    const messages = await client.getMessages(channel, { limit: 100 });
    
    let targetMessage = null;
    
    for (const message of messages) {
      if (message.media && message.media.document) {
        const doc = message.media.document;
        const attributes = doc.attributes || [];
        const fileAttr = attributes.find(attr => attr.fileName);
        
        if (fileAttr && fileAttr.fileName === fileName) {
          targetMessage = message;
          break;
        }
      }
    }

    if (!targetMessage) {
      return res.status(404).json({ error: 'Видео не найдено' });
    }

    // Генерируем файл
    const uploadId = uuidv4();
    const extension = path.extname(fileName) || '.mp4';
    const localFileName = `${uploadId}${extension}`;
    const localFilePath = path.join(uploadDir, localFileName);

    console.log('Загружаем файл...');
    
    await client.downloadMedia(targetMessage, {
      outputFile: localFilePath,
      progressCallback: (received, total) => {
        const percent = Math.round((received / total) * 100);
        if (percent % 20 === 0) {
          console.log(`Прогресс: ${percent}%`);
        }
      }
    });

    const stats = await fs.stat(localFilePath);
    const baseUrl = `https://${req.get('host')}`;
    
    // Возвращаем URL для скачивания
    res.json({
      success: true,
      fileName: fileName,
      filePath: `videos/${localFileName}`,
      fileUrl: `${baseUrl}/download/${uploadId}`,
      fileSize: stats.size,
      fileSizeMB: Math.round(stats.size / 1024 / 1024),
      expiresIn: '15 minutes'
    });
    
    // Удаляем через 15 минут
    setTimeout(async () => {
      try {
        await fs.unlink(localFilePath);
        console.log(`Файл удален: ${localFileName}`);
      } catch (err) {}
    }, 15 * 60 * 1000);

  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ 
      error: 'Ошибка обработки',
      details: error.message 
    });
  }
});

// Эндпоинт для скачивания файла по ID
app.get('/download/:uploadId', async (req, res) => {
  try {
    const { uploadId } = req.params;
    const files = await fs.readdir(uploadDir);
    
    const file = files.find(f => f.startsWith(uploadId));
    
    if (!file) {
      return res.status(404).json({ error: 'Файл не найден' });
    }

    const filePath = path.join(uploadDir, file);
    const stats = await fs.stat(filePath);
    
    // Отправляем файл
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
    
    const readStream = require('fs').createReadStream(filePath);
    readStream.pipe(res);
    
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения файла' });
  }
});

// Тестовый эндпоинт
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    activeSessions: telegramClients.size
  });
});

// Очистка старых файлов
setInterval(async () => {
  try {
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 час

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        console.log(`Очистка: удален ${file}`);
      }
    }
  } catch (error) {
    console.error('Ошибка очистки:', error);
  }
}, 30 * 60 * 1000); // Каждые 30 минут

// Запуск сервера
app.listen(PORT, () => {
  console.log(`\n✅ Сервер запущен на порту ${PORT}`);
  console.log(`\nДоступные эндпоинты:`);
  console.log(`  POST /make-download     - Загрузка видео (до 95MB)`);
  console.log(`  POST /make-download-url - Загрузка больших видео (возвращает URL)`);
  console.log(`  GET  /download/:id      - Скачать файл по ID`);
  console.log(`  GET  /health            - Проверка статуса\n`);
});