const express = require('express');
const { TelegramClient, Api } = require('telegram');
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

// Глобальный клиент бота
let botClient = null;

// Инициализация бота
async function initializeBot() {
  try {
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!apiId || !apiHash || !botToken) {
      throw new Error('Отсутствуют необходимые переменные окружения');
    }

    console.log('🤖 Инициализация Telegram бота...');

    // Создаем клиент для бота
    botClient = new TelegramClient(
      new StringSession(''),
      apiId,
      apiHash,
      {
        connectionRetries: 5,
        useWSS: false
      }
    );

    // Подключаемся как бот
    await botClient.start({
      botAuthToken: botToken,
      onError: (err) => console.error('Ошибка авторизации:', err),
    });

    console.log('✅ Бот успешно подключен!');
    
    // Получаем информацию о боте
    const me = await botClient.getMe();
    console.log(`🤖 Бот: @${me.username} (ID: ${me.id})`);

  } catch (error) {
    console.error('❌ Ошибка инициализации бота:', error);
    process.exit(1);
  }
}

// Основной эндпоинт для Make.com
app.post('/download-bot', async (req, res) => {
  try {
    const { channelUsername, fileName } = req.body;
    
    console.log(`📥 Запрос на скачивание: ${fileName} из ${channelUsername}`);
    
    if (!channelUsername || !fileName) {
      return res.status(400).json({ 
        error: 'Необходимо указать channelUsername и fileName' 
      });
    }

    // Убираем @ если есть
    const cleanUsername = channelUsername.replace('@', '');
    
    try {
      // Получаем канал/чат
      let entity;
      try {
        // Сначала пробуем как username
        entity = await botClient.getEntity(cleanUsername);
      } catch (e) {
        // Если не удалось, пробуем как ID чата
        const chatId = parseInt(cleanUsername);
        if (!isNaN(chatId)) {
          entity = await botClient.getEntity(chatId);
        } else {
          throw e;
        }
      }
      
      console.log(`📍 Найден канал/чат: ${entity.title || entity.firstName || 'Unknown'}`);
      
      // Ищем сообщение с файлом
      const messages = await botClient.getMessages(entity, { 
        limit: 100  // Увеличиваем лимит для поиска
      });
      
      console.log(`📨 Найдено сообщений: ${messages.length}`);
      
      let targetMessage = null;
      let fileInfo = null;
      
      for (const message of messages) {
        if (message.media) {
          let docFileName = null;
          let document = null;
          
          // Проверяем разные типы медиа
          if (message.media.className === 'MessageMediaDocument' && message.media.document) {
            document = message.media.document;
            const attrs = document.attributes || [];
            const fileAttr = attrs.find(attr => attr.className === 'DocumentAttributeFilename');
            docFileName = fileAttr ? fileAttr.fileName : null;
          }
          
          // Проверяем совпадение имени файла
          if (docFileName === fileName) {
            targetMessage = message;
            fileInfo = {
              fileName: docFileName,
              fileSize: document.size,
              mimeType: document.mimeType
            };
            console.log(`✅ Файл найден: ${docFileName} (${(fileInfo.fileSize / 1024 / 1024).toFixed(2)} MB)`);
            break;
          }
        }
      }
      
      if (!targetMessage) {
        // Выводим список найденных файлов для отладки
        console.log('📋 Доступные файлы в канале:');
        for (const msg of messages) {
          if (msg.media && msg.media.document) {
            const attrs = msg.media.document.attributes || [];
            const fileAttr = attrs.find(attr => attr.className === 'DocumentAttributeFilename');
            if (fileAttr) {
              console.log(`  - ${fileAttr.fileName}`);
            }
          }
        }
        
        return res.status(404).json({ 
          error: 'Файл не найден',
          hint: 'Проверьте правильность имени файла и доступность канала для бота'
        });
      }
      
      // Генерируем уникальное имя для временного файла
      const uploadId = uuidv4();
      const tempFileName = `${uploadId}_${fileName}`;
      const localPath = path.join(uploadDir, tempFileName);
      
      console.log(`⏬ Начинаем загрузку файла...`);
      
      // Загружаем файл
      const buffer = await botClient.downloadMedia(targetMessage.media, {
        progressCallback: (downloaded, total) => {
          const percent = Math.round((downloaded / total) * 100);
          if (percent % 10 === 0) {
            console.log(`  Прогресс: ${percent}% (${(downloaded / 1024 / 1024).toFixed(2)} / ${(total / 1024 / 1024).toFixed(2)} MB)`);
          }
        }
      });
      
      // Сохраняем файл
      await fs.writeFile(localPath, buffer);
      console.log(`💾 Файл сохранен: ${localPath}`);
      
      const stats = await fs.stat(localPath);
      
      // Для файлов меньше 95MB - возвращаем напрямую
      if (stats.size < 95 * 1024 * 1024) {
        res.setHeader('Content-Type', fileInfo.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', stats.size);
        
        const fileBuffer = await fs.readFile(localPath);
        res.send(fileBuffer);
        
        // Удаляем файл через 5 секунд
        setTimeout(async () => {
          try {
            await fs.unlink(localPath);
            console.log(`🗑️ Временный файл удален: ${tempFileName}`);
          } catch (e) {}
        }, 5000);
        
      } else {
        // Для больших файлов возвращаем ссылку
        const downloadToken = Buffer.from(JSON.stringify({
          uploadId: uploadId,
          fileName: fileName,
          mimeType: fileInfo.mimeType,
          exp: Date.now() + (30 * 60 * 1000) // 30 минут
        })).toString('base64');
        
        const baseUrl = `https://${req.get('host')}`;
        
        res.json({
          success: true,
          fileName: fileName,
          fileSize: stats.size,
          fileSizeMB: (stats.size / 1024 / 1024).toFixed(2),
          mimeType: fileInfo.mimeType,
          downloadUrl: `${baseUrl}/file/${downloadToken}`,
          expiresIn: '30 minutes'
        });
        
        // Удаляем через 30 минут
        setTimeout(async () => {
          try {
            await fs.unlink(localPath);
            console.log(`🗑️ Временный файл удален: ${tempFileName}`);
          } catch (e) {}
        }, 30 * 60 * 1000);
      }
      
    } catch (error) {
      console.error('❌ Ошибка при работе с Telegram:', error);
      
      if (error.message.includes('CHANNEL_PRIVATE')) {
        return res.status(403).json({ 
          error: 'Канал приватный. Убедитесь, что бот добавлен в канал как администратор' 
        });
      }
      
      if (error.message.includes('USERNAME_NOT_OCCUPIED')) {
        return res.status(404).json({ 
          error: 'Канал не найден. Проверьте правильность username' 
        });
      }
      
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Общая ошибка:', error);
    res.status(500).json({ 
      error: 'Внутренняя ошибка сервера',
      details: error.message 
    });
  }
});

// Эндпоинт для скачивания больших файлов по токену
app.get('/file/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    // Декодируем токен
    const data = JSON.parse(Buffer.from(token, 'base64').toString());
    
    if (Date.now() > data.exp) {
      return res.status(403).json({ error: 'Ссылка истекла' });
    }
    
    const tempFileName = `${data.uploadId}_${data.fileName}`;
    const filePath = path.join(uploadDir, tempFileName);
    
    try {
      const stats = await fs.stat(filePath);
      
      res.setHeader('Content-Type', data.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${data.fileName}"`);
      
      const stream = require('fs').createReadStream(filePath);
      stream.pipe(res);
      
    } catch (error) {
      res.status(404).json({ error: 'Файл не найден' });
    }
    
  } catch (error) {
    res.status(400).json({ error: 'Неверный токен' });
  }
});

// Health check endpoints
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    server: 'Telegram Bot Video Proxy',
    version: '4.0.0',
    bot: botClient ? 'Connected' : 'Not connected'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    uptime: process.uptime()
  });
});

// Очистка старых файлов
setInterval(async () => {
  try {
    const files = await fs.readdir(uploadDir);
    const now = Date.now();
    
    for (const file of files) {
      if (file === '.gitkeep') continue;
      
      const filePath = path.join(uploadDir, file);
      const stats = await fs.stat(filePath);
      
      // Удаляем файлы старше 1 часа
      if (now - stats.mtimeMs > 60 * 60 * 1000) {
        await fs.unlink(filePath);
        console.log(`🗑️ Удален старый файл: ${file}`);
      }
    }
  } catch (error) {
    console.error('Ошибка при очистке:', error);
  }
}, 10 * 60 * 1000); // каждые 10 минут

// Запуск сервера
async function startServer() {
  await initializeBot();
  
  app.listen(PORT, () => {
    console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📡 Эндпоинты:`);
    console.log(`   POST /download-bot - Скачивание файлов через бота`);
    console.log(`   GET  /file/:token  - Получение больших файлов`);
    console.log(`   GET  /health       - Проверка состояния\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Останавливаем сервер...');
  
  if (botClient && botClient.connected) {
    await botClient.disconnect();
  }
  
  process.exit(0);
});

// Запускаем сервер
startServer().catch(console.error);