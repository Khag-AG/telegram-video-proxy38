const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool, initDatabase } = require('./db');
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

// Хранилище активных ботов
const activeBots = new Map();

// Инициализация всех ботов при запуске
async function initializeAllBots() {
  await initDatabase();
  
  try {
    const result = await pool.query('SELECT * FROM bots WHERE is_active = true');
    const bots = result.rows;
    
    console.log(`🤖 Найдено ${bots.length} активных ботов`);
    
    for (const bot of bots) {
      try {
        await initializeBotClient(bot);
      } catch (error) {
        console.error(`❌ Ошибка инициализации бота ${bot.name}:`, error);
        // Отмечаем бота как неактивного при ошибке
        await pool.query('UPDATE bots SET is_active = false WHERE id = $1', [bot.id]);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки ботов из БД:', error);
  }
}

// Инициализация клиента бота
async function initializeBotClient(botData) {
  const { id, name, token, api_id, api_hash } = botData;
  
  console.log(`🔄 Инициализация бота: ${name}`);
  
  const client = new TelegramClient(
    new StringSession(''),
    parseInt(api_id),
    api_hash,
    {
      connectionRetries: 5,
      useWSS: false
    }
  );

  await client.start({
    botAuthToken: token,
    onError: (err) => console.error(`Ошибка авторизации бота ${name}:`, err),
  });

  const me = await client.getMe();
  console.log(`✅ Бот ${name} подключен: @${me.username} (ID: ${me.id})`);
  
  activeBots.set(id, {
    id,
    name,
    client,
    info: me
  });
}

// Получение бота для канала
async function getBotForChannel(chatId) {
  try {
    // Ищем привязку канала к боту
    const result = await pool.query(
      'SELECT bot_id FROM channel_bot_mapping WHERE chat_id = $1',
      [chatId]
    );
    
    if (result.rows.length === 0) {
      console.log(`⚠️ Нет привязки для канала ${chatId}`);
      
      // Если привязки нет, используем первого активного бота
      const firstBot = Array.from(activeBots.values())[0];
      if (firstBot) {
        console.log(`📌 Используем бота по умолчанию: ${firstBot.name}`);
        
        // Автоматически создаем привязку
        await pool.query(
          'INSERT INTO channel_bot_mapping (chat_id, bot_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [chatId, firstBot.id]
        );
        
        return firstBot;
      }
      
      throw new Error('Нет доступных ботов');
    }
    
    const botId = result.rows[0].bot_id;
    const bot = activeBots.get(botId);
    
    if (!bot) {
      throw new Error(`Бот с ID ${botId} не активен`);
    }
    
    return bot;
  } catch (error) {
    console.error('Ошибка получения бота для канала:', error);
    throw error;
  }
}

// Основной эндпоинт для Make.com
app.post('/download-bot', async (req, res) => {
  const startTime = Date.now();
  let bot = null;
  
  try {
    const { file_id, file_name, message_id, chat_id } = req.body;
    
    console.log(`\n📥 Новый запрос на скачивание:`);
    console.log(`   Файл: ${file_name} (${file_id})`);
    console.log(`   Канал: ${chat_id}`);
    console.log(`   Сообщение: ${message_id}`);
    
    if (!file_id || !message_id || !chat_id) {
      return res.status(400).json({ 
        error: 'Необходимо указать file_id, message_id и chat_id' 
      });
    }

    // Получаем подходящего бота для канала
    bot = await getBotForChannel(chat_id);
    console.log(`🤖 Используем бота: ${bot.name}`);

    try {
      // Получаем сообщение по ID
      const messages = await bot.client.invoke(
        new Api.channels.GetMessages({
          channel: await bot.client.getEntity(chat_id),
          id: [new Api.InputMessageID({ id: message_id })]
        })
      );
      
      if (!messages.messages || messages.messages.length === 0) {
        throw new Error('Сообщение не найдено');
      }
      
      const message = messages.messages[0];
      if (!message.media) {
        throw new Error('В сообщении нет медиа');
      }
      
      console.log(`⏬ Начинаем загрузку файла через MTProto...`);
      
      // Загружаем файл
      const buffer = await bot.client.downloadMedia(message.media, {
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
      const extension = path.extname(originalFileName) || '.mp4';
      const safeFileName = `${uploadId}${extension}`;
      const localPath = path.join(uploadDir, safeFileName);
      
      // Сохраняем файл
      await fs.writeFile(localPath, buffer);
      console.log(`💾 Файл сохранен: ${localPath}`);
      
      const stats = await fs.stat(localPath);
      const fileSizeMB = stats.size / 1024 / 1024;
      
      // Создаем прямую ссылку на файл
      const publicDomain = process.env.PUBLIC_DOMAIN || 'telegram-video-proxy38-production.up.railway.app';
      const directUrl = `https://${publicDomain}/uploads/${safeFileName}`;
      
      // Логируем успешную загрузку
      await pool.query(
        `INSERT INTO download_logs (chat_id, bot_id, file_name, file_size, status) 
         VALUES ($1, $2, $3, $4, $5)`,
        [chat_id, bot.id, originalFileName, stats.size, 'success']
      );
      
      const duration = Date.now() - startTime;
      console.log(`✅ Загрузка завершена за ${(duration / 1000).toFixed(2)} сек`);
      console.log(`🔗 Прямая ссылка: ${directUrl}`);
      console.log(`📊 Размер: ${fileSizeMB.toFixed(2)} MB`);
      
      // Отправляем ответ в формате, понятном Make.com
      res.json({
        fileName: originalFileName,
        safeFileName: safeFileName,
        filePath: `videos/${originalFileName}`,
        fileUrl: directUrl,
        fileSize: stats.size,
        fileSizeMB: fileSizeMB.toFixed(2),
        botUsed: bot.name,
        duration: duration,
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
      
      // Логируем ошибку
      await pool.query(
        `INSERT INTO download_logs (chat_id, bot_id, file_name, status, error_message) 
         VALUES ($1, $2, $3, $4, $5)`,
        [chat_id, bot.id, file_name, 'error', error.message]
      );
      
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

// Эндпоинт для получения информации о ботах
app.get('/bots-status', async (req, res) => {
  const botsInfo = Array.from(activeBots.values()).map(bot => ({
    id: bot.id,
    name: bot.name,
    username: bot.info.username,
    active: true
  }));
  
  res.json({
    total: botsInfo.length,
    bots: botsInfo
  });
});

// Health check endpoints
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    server: 'Multi-Bot Telegram Video Proxy',
    version: '4.0.0',
    activeBots: activeBots.size,
    adminPanel: `Port ${process.env.ADMIN_PORT || 3001}`
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    uptime: process.uptime(),
    bots: activeBots.size
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
  await initializeAllBots();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📡 Эндпоинты:`);
    console.log(`   POST /download-bot  - Скачивание файлов`);
    console.log(`   GET  /bots-status   - Статус ботов`);
    console.log(`   GET  /health        - Проверка состояния`);
    console.log(`\n🔧 Админ панель доступна на порту ${process.env.ADMIN_PORT || 3001}\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Останавливаем сервер...');
  
  // Отключаем всех ботов
  for (const bot of activeBots.values()) {
    if (bot.client && bot.client.connected) {
      await bot.client.disconnect();
    }
  }
  
  // Закрываем пул соединений с БД
  await pool.end();
  
  process.exit(0);
});

// Запускаем сервер
startServer().catch(console.error);