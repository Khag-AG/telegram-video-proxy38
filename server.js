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

// Настройка CORS
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Создаем директории
const uploadDir = path.join(__dirname, 'uploads');
const sessionsDir = path.join(__dirname, 'sessions');
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);
fs.mkdir(sessionsDir, { recursive: true }).catch(console.error);

// Хранилище активных клиентов
const telegramClients = new Map();

// Функция создания клиента для конкретной сессии
async function getTelegramClient(sessionId, sessionString) {
  try {
    // Проверяем, есть ли уже активный клиент
    if (telegramClients.has(sessionId)) {
      const client = telegramClients.get(sessionId);
      if (client.connected) {
        return client;
      }
    }

    // Создаем новый клиент
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const stringSession = new StringSession(sessionString);

    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: true
    });

    await client.connect();
    
    // Сохраняем клиент
    telegramClients.set(sessionId, client);
    
    // Автоматически отключаем неактивные клиенты через 30 минут
    setTimeout(() => {
      if (telegramClients.has(sessionId)) {
        client.disconnect();
        telegramClients.delete(sessionId);
        console.log(`Клиент ${sessionId} отключен по таймауту`);
      }
    }, 30 * 60 * 1000);

    return client;
  } catch (error) {
    console.error(`Ошибка создания клиента для ${sessionId}:`, error);
    throw error;
  }
}

// API для создания новой сессии (для первичной настройки клиента)
app.post('/create-session', async (req, res) => {
  try {
    const { phoneNumber, password, code, clientName } = req.body;
    
    if (!phoneNumber || !clientName) {
      return res.status(400).json({ 
        error: 'phoneNumber и clientName обязательны' 
      });
    }

    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const stringSession = new StringSession('');

    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    // Если это первый запрос - начинаем авторизацию
    if (!code) {
      await client.connect();
      await client.sendCode(
        {
          apiId: apiId,
          apiHash: apiHash,
        },
        phoneNumber
      );
      
      return res.json({
        status: 'code_required',
        message: 'Код отправлен в Telegram'
      });
    }

    // Если есть код - завершаем авторизацию
    await client.start({
      phoneNumber: () => phoneNumber,
      password: () => password || '',
      phoneCode: () => code,
      onError: (err) => {
        throw err;
      },
    });

    const sessionString = client.session.save();
    const sessionId = uuidv4();
    
    // Сохраняем сессию
    const sessionData = {
      id: sessionId,
      clientName: clientName,
      phoneNumber: phoneNumber,
      session: sessionString,
      createdAt: new Date().toISOString()
    };
    
    const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
    await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));
    
    // Отключаем клиент
    await client.disconnect();

    res.json({
      status: 'success',
      sessionId: sessionId,
      message: 'Сессия создана успешно'
    });

  } catch (error) {
    console.error('Ошибка создания сессии:', error);
    res.status(500).json({ 
      error: 'Ошибка создания сессии',
      details: error.message 
    });
  }
});

// API для загрузки видео
app.post('/download-video', async (req, res) => {
  try {
    const { 
      sessionId, 
      channelUsername, 
      fileName, 
      messageId,
      fileSize 
    } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ 
        error: 'sessionId обязателен' 
      });
    }

    // Загружаем данные сессии
    const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
    let sessionData;
    
    try {
      const data = await fs.readFile(sessionPath, 'utf8');
      sessionData = JSON.parse(data);
    } catch (error) {
      return res.status(404).json({ 
        error: 'Сессия не найдена' 
      });
    }

    // Получаем клиент
    const client = await getTelegramClient(sessionId, sessionData.session);
    
    // Получаем канал
    const channel = await client.getEntity(channelUsername);
    
    // Ищем сообщение
    const messages = await client.getMessages(channel, { 
      limit: 50,
      reverse: true 
    });
    
    let targetMessage = null;
    
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attributes = message.media.document.attributes || [];
        const hasFileName = attributes.some(attr => 
          attr.fileName === fileName
        );
        
        // Проверяем по имени файла или размеру
        if (hasFileName || 
            (fileSize && Math.abs(message.media.document.size - fileSize) < 1000)) {
          targetMessage = message;
          break;
        }
      }
    }

    if (!targetMessage) {
      return res.status(404).json({ 
        error: 'Видео не найдено в канале' 
      });
    }

    // Генерируем уникальное имя
    const uniqueId = uuidv4();
    const extension = path.extname(fileName || 'video.mp4');
    const localFileName = `${uniqueId}${extension}`;
    const localFilePath = path.join(uploadDir, localFileName);

    console.log(`[${sessionData.clientName}] Загружаем: ${fileName}`);

    // Загружаем файл
    await client.downloadMedia(targetMessage, {
      outputFile: localFilePath,
      progressCallback: (received, total) => {
        const percent = Math.round((received / total) * 100);
        if (percent % 20 === 0) {
          console.log(`[${sessionData.clientName}] Прогресс: ${percent}%`);
        }
      }
    });

    const stats = await fs.stat(localFilePath);
    
    res.json({
      success: true,
      uploadId: uniqueId,
      fileName: localFileName,
      size: stats.size,
      downloadUrl: `${req.protocol}://${req.get('host')}/file/${uniqueId}`,
      clientName: sessionData.clientName
    });

  } catch (error) {
    console.error('Ошибка загрузки:', error);
    res.status(500).json({ 
      error: 'Ошибка загрузки видео',
      details: error.message 
    });
  }
});

// API для получения бинарных данных
app.get('/file/:uploadId', async (req, res) => {
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
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    
    const readStream = require('fs').createReadStream(filePath);
    readStream.pipe(res);
    
    // Планируем удаление
    readStream.on('end', () => {
      setTimeout(async () => {
        try {
          await fs.unlink(filePath);
          console.log(`Файл удален: ${file}`);
        } catch (err) {
          // Файл уже удален
        }
      }, 5000);
    });

  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ 
      error: 'Ошибка получения файла' 
    });
  }
});

// API для управления сессиями
app.get('/sessions', async (req, res) => {
  try {
    const files = await fs.readdir(sessionsDir);
    const sessions = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readFile(path.join(sessionsDir, file), 'utf8');
        const session = JSON.parse(data);
        sessions.push({
          id: session.id,
          clientName: session.clientName,
          phoneNumber: session.phoneNumber.slice(0, -4) + '****',
          createdAt: session.createdAt,
          active: telegramClients.has(session.id)
        });
      }
    }
    
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения сессий' });
  }
});

// API для удаления сессии
app.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Отключаем клиент если активен
    if (telegramClients.has(sessionId)) {
      const client = telegramClients.get(sessionId);
      await client.disconnect();
      telegramClients.delete(sessionId);
    }
    
    // Удаляем файл сессии
    const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
    await fs.unlink(sessionPath);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка удаления сессии' });
  }
});

// Проверка здоровья
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    activeSessions: telegramClients.size,
    uptime: process.uptime()
  });
});

// Админ панель
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Очистка старых файлов
setInterval(async () => {
  try {
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 часа

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
}, 60 * 60 * 1000); // Каждый час

// Специальный эндпоинт для Make.com с поддержкой сессий
app.post('/make-download', async (req, res) => {
  try {
    const { 
      sessionId, 
      channelUsername, 
      fileName, 
      fileSize,
      outputFormat = 'url' // 'url' или 'data'
    } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ 
        error: 'sessionId обязателен' 
      });
    }

    // Загружаем данные сессии
    const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
    let sessionData;
    
    try {
      const data = await fs.readFile(sessionPath, 'utf8');
      sessionData = JSON.parse(data);
    } catch (error) {
      return res.status(404).json({ 
        error: 'Сессия не найдена' 
      });
    }

    // Получаем клиент
    const client = await getTelegramClient(sessionId, sessionData.session);
    
    console.log(`[Make.com] ${sessionData.clientName} загружает ${fileName}`);
    
    // Получаем канал
    const channel = await client.getEntity(channelUsername);
    
    // Ищем видео
    const messages = await client.getMessages(channel, { 
      limit: 100,
      reverse: true 
    });
    
    let targetMessage = null;
    
    for (const message of messages) {
      if (message.media && message.media.document) {
        const attributes = message.media.document.attributes || [];
        const hasFileName = attributes.some(attr => 
          attr.fileName === fileName
        );
        
        if (hasFileName || 
            (fileSize && Math.abs(message.media.document.size - fileSize) < 1000)) {
          targetMessage = message;
          break;
        }
      }
    }

    if (!targetMessage) {
      return res.status(404).json({ 
        error: 'Видео не найдено в канале' 
      });
    }

    // Генерируем уникальное имя
    const uniqueId = uuidv4();
    const extension = path.extname(fileName || 'video.mp4');
    const localFileName = `${uniqueId}${extension}`;
    const localFilePath = path.join(uploadDir, localFileName);

    console.log(`[Make.com] Начинаем загрузку...`);

    // Загружаем файл
    await client.downloadMedia(targetMessage, {
      outputFile: localFilePath,
      progressCallback: (received, total) => {
        const percent = Math.round((received / total) * 100);
        if (percent % 20 === 0) {
          console.log(`[Make.com] ${sessionData.clientName}: ${percent}%`);
        }
      }
    });

    const stats = await fs.stat(localFilePath);
    console.log(`[Make.com] Загружено: ${Math.round(stats.size / 1024 / 1024)}MB`);

    // Для файлов меньше 95MB можем вернуть данные напрямую
    if (stats.size < 95 * 1024 * 1024 && outputFormat === 'data') {
      const fileBuffer = await fs.readFile(localFilePath);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-Upload-Id', uniqueId);
      res.setHeader('X-File-Name', fileName);
      res.setHeader('X-File-Size', stats.size);
      res.send(fileBuffer);
      
      // Удаляем файл через 10 секунд
      setTimeout(() => {
        fs.unlink(localFilePath).catch(() => {});
      }, 10000);
      
    } else {
      // Для больших файлов возвращаем информацию для скачивания
      const baseUrl = `https://${req.get('host')}`;
      
      res.json({
        success: true,
        uploadId: uniqueId,
        fileName: fileName,
        fileSize: stats.size,
        fileSizeMB: Math.round(stats.size / 1024 / 1024),
        downloadUrl: `${baseUrl}/file/${uniqueId}`,
        directUrl: `${baseUrl}/direct/${uniqueId}/${encodeURIComponent(fileName)}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        clientName: sessionData.clientName
      });
      
      // Удаляем файл через 30 минут
      setTimeout(() => {
        fs.unlink(localFilePath).catch(() => {});
      }, 30 * 60 * 1000);
    }
    
  } catch (error) {
    console.error('[Make.com] Ошибка:', error);
    res.status(500).json({ 
      error: 'Ошибка загрузки видео',
      details: error.message 
    });
  }
});

// Эндпоинт для прямой загрузки с именем файла
app.get('/direct/:uploadId/:filename', async (req, res) => {
  try {
    const { uploadId } = req.params;
    const files = await fs.readdir(uploadDir);
    
    const file = files.find(f => f.startsWith(uploadId));
    
    if (!file) {
      return res.status(404).json({ error: 'Файл не найден' });
    }

    const filePath = path.join(uploadDir, file);
    const stats = await fs.stat(filePath);
    
    // Отправляем файл с правильными заголовками
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `inline; filename="${req.params.filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    
    const readStream = require('fs').createReadStream(filePath);
    readStream.pipe(res);
    
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка получения файла' });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`\nМультитенантный сервер запущен на порту ${PORT}`);
  console.log(`\nAPI endpoints:`);
  console.log(`  POST   /create-session     - Создание новой сессии`);
  console.log(`  POST   /download-video     - Загрузка видео`);
  console.log(`  GET    /file/:uploadId     - Получение файла`);
  console.log(`  GET    /sessions           - Список сессий`);
  console.log(`  DELETE /sessions/:id       - Удаление сессии`);
  console.log(`  GET    /health             - Статус сервера\n`);
});