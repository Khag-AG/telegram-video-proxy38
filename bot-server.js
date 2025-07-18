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

// Обслуживание статических файлов из папки uploads
app.use('/uploads', express.static(uploadDir));

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
    const { file_id, file_name, message_id, chat_id } = req.body;
    
    console.log(`📥 Запрос на скачивание: ${file_name} (${file_id})`);
    console.log(`📍 Message ID: ${message_id}, Chat ID: ${chat_id}`);
    
    if (!file_id || !message_id || !chat_id) {
      return res.status(400).json({ 
        error: 'Необходимо указать file_id, message_id и chat_id' 
      });
    }

    try {
      console.log('Используем MTProto для скачивания...');
      
      // Получаем сообщение по ID
      const messages = await botClient.invoke(
        new Api.channels.GetMessages({
          channel: await botClient.getEntity(chat_id),
          id: [new Api.InputMessageID({ id: message_id })]
        })
      );
      
      if (!messages.messages || messages.messages.length === 0) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
      }
      
      const message = messages.messages[0];
      if (!message.media) {
        return res.status(404).json({ error: 'В сообщении нет медиа' });
      }
      
      console.log(`⏬ Начинаем загрузку файла через MTProto...`);
      
      // Загружаем файл
      const buffer = await botClient.downloadMedia(message.media, {
        progressCallback: (downloaded, total) => {
          const percent = Math.round((downloaded / total) * 100);
          if (percent % 10 === 0) {
            console.log(`  Прогресс: ${percent}% (${(downloaded / 1024 / 1024).toFixed(2)} / ${(total / 1024 / 1024).toFixed(2)} MB)`);
          }
        }
      });
      
      // Генерируем имя файла
      const originalFileName = file_name || `file_${Date.now()}.mp4`;
      const uploadId = uuidv4();
      // Создаем безопасное имя файла для URL (только латиница и цифры)
      const extension = path.extname(originalFileName) || '.mp4';
      const safeFileName = `${uploadId}${extension}`;
      const localPath = path.join(uploadDir, safeFileName);
      
      // Сохраняем файл
      await fs.writeFile(localPath, buffer);
      console.log(`💾 Файл сохранен: ${localPath}`);
      
      const stats = await fs.stat(localPath);
      const fileSizeMB = stats.size / 1024 / 1024;
      
      // Создаем прямую ссылку на файл
      const publicDomain = 'telegram-video-proxy38-production.up.railway.app';
      const directUrl = `https://${publicDomain}/uploads/${safeFileName}`;
      
      console.log(`🔗 Прямая ссылка: ${directUrl}`);
      console.log(`📤 Файл размером ${fileSizeMB.toFixed(2)} MB`);
      
      // Отправляем ответ в формате, понятном Make.com
      res.json({
        fileName: originalFileName, // Оригинальное имя для отображения
        safeFileName: safeFileName, // Безопасное имя для URL
        filePath: `videos/${originalFileName}`,
        fileUrl: directUrl,
        fileSize: stats.size,
        fileSizeMB: fileSizeMB.toFixed(2),
        success: true
      });
      
      // Удаляем через 30 минут
      setTimeout(async () => {
        try {
          await fs.unlink(localPath);
          console.log(`🗑️ Временный файл удален: ${safeFileName}`);
        } catch (e) {}
      }, 30 * 60 * 1000);
      
    } catch (error) {
      console.error('❌ Ошибка MTProto:', error);
      return res.status(500).json({ 
        error: 'Не удалось скачать файл через MTProto',
        details: error.message 
      });
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
    
    // Декодируем токен - используем base64url
    const data = JSON.parse(Buffer.from(token, 'base64url').toString());
    
    if (Date.now() > data.exp) {
      return res.status(403).json({ error: 'Ссылка истекла' });
    }
    
    const tempFileName = `${data.uploadId}_${data.fileName}`;
    const filePath = path.join(uploadDir, tempFileName);
    
    try {
      const stats = await fs.stat(filePath);
      
      res.setHeader('Content-Type', 'application/octet-stream');
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
  
  const PORT = process.env.PORT || 3000;
  
  app.listen(PORT, '0.0.0.0', () => {
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
