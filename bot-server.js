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

// Функция транслитерации
function transliterate(str) {
  const ru = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 
    'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 
    'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 
    'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 
    'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 
    'э': 'e', 'ю': 'yu', 'я': 'ya',
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D',
    'Е': 'E', 'Ё': 'E', 'Ж': 'Zh', 'З': 'Z', 'И': 'I',
    'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N',
    'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T',
    'У': 'U', 'Ф': 'F', 'Х': 'H', 'Ц': 'C', 'Ч': 'Ch',
    'Ш': 'Sh', 'Щ': 'Sch', 'Ъ': '', 'Ы': 'Y', 'Ь': '',
    'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
    ' ': '_'
  };
  
  return str.split('').map(char => ru[char] || char).join('');
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
      
      // Генерируем имя файла с транслитерацией
      const originalFileName = file_name || `file_${Date.now()}.mp4`;
      const transliteratedFileName = transliterate(originalFileName);
      const uploadId = uuidv4();
      const extension = path.extname(transliteratedFileName) || '.mp4';
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
      
      // Получаем ТОЧНО первые 128 байт файла для hex превью
      const previewBuffer = Buffer.alloc(128); // 128 байт, НЕ 180!
      buffer.copy(previewBuffer, 0, 0, 128);
      const hexPreview = previewBuffer.toString('hex'); // 256 символов

      // SHA-1 хеш БЕЗ обрезания!
      const hash = crypto.createHash('sha1').update(buffer).digest('hex'); // 40 символов

      // Формируем data-поле
      const dataField = `IMTBuffer(${stats.size}, binary, ${hash}): ${hexPreview}`;

      // Логируем для проверки
      console.log(`📊 Hex preview length: ${hexPreview.length} (должно быть 256)`);
      console.log(`📊 Hash length: ${hash.length} (должно быть 40)`);
      console.log(`📊 Full data field: ${dataField}`);

      // Определяем MIME тип
      let contentType = 'video/mp4';
      if (extension === '.mp4') contentType = 'video/mp4';
      else if (extension === '.mkv') contentType = 'video/x-matroska';
      else if (extension === '.avi') contentType = 'video/x-msvideo';
      else if (extension === '.mov') contentType = 'video/quicktime';
      
      // Формируем ответ в формате Make.com (как HTTP модуль)
      const makeResponse = {
        statusCode: 200,
        headers: [
          {
            name: "accept-ranges",
            value: "bytes"
          },
          {
            name: "access-control-allow-origin",
            value: "*"
          },
          {
            name: "cache-control",
            value: "public, max-age=0"
          },
          {
            name: "content-length",
            value: stats.size.toString()
          },
          {
            name: "content-type",
            value: contentType
          },
          {
            name: "date",
            value: new Date().toUTCString()
          },
          {
            name: "etag",
            value: `W/"${stats.size.toString(16)}-${Date.now().toString(16)}"`
          },
          {
            name: "last-modified",
            value: new Date().toUTCString()
          },
          {
            name: "server",
            value: "railway-edge"
          },
          {
            name: "x-powered-by",
            value: "Express"
          },
          {
            name: "x-railway-edge",
            value: "railway/us-east4-eqdc4a"
          },
          {
            name: "x-railway-request-id",
            value: uploadId
          }
        ],
        cookieHeaders: [],
        data: `IMTBuffer(${stats.size}, binary, ${hash}): ${hexPreview}`,
        fileSize: stats.size,
        fileName: transliteratedFileName,
        // Дополнительные поля для обратной совместимости
        fileUrl: directUrl,
        safeFileName: safeFileName,
        filePath: `videos/${transliteratedFileName}`,
        fileSizeMB: fileSizeMB.toFixed(2),
        botUsed: bot.name,
        duration: duration,
        success: true
      };
      
      // Проверяем длину hex preview
      if (hexPreview.length !== 256) {
        console.error(`❌ ОШИБКА: Hex preview неправильной длины: ${hexPreview.length} вместо 256`);
        // Принудительно обрезаем до 256 символов
        hexPreview = hexPreview.substring(0, 256);
      }

      // Отправляем ответ
      res.json(makeResponse);
      
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
      
      return res.status(500).json([{ 
        error: 'Не удалось скачать файл через MTProto',
        details: error.message 
      }]);
    }
    
  } catch (error) {
    console.error('❌ Общая ошибка:', error);
    res.status(500).json([{ 
      error: 'Внутренняя ошибка сервера',
      details: error.message 
    }]);
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
    console.log(`   GET  /admin         - Админ панель`);
    console.log(`\n🔑 Админ панель: https://telegram-video-proxy38-production.up.railway.app/admin\n`);
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

// ========== АДМИН ПАНЕЛЬ ==========
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Обслуживание файлов админки
app.use('/admin', express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-me';

// Middleware для проверки токена
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Нет токена авторизации' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
};

// Вход в админку
app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Пароль обязателен' });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// Получить список ботов
app.get('/api/bots', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, COUNT(DISTINCT cbm.id) as channels_count, COUNT(DISTINCT dl.id) as downloads_count
      FROM bots b
      LEFT JOIN channel_bot_mapping cbm ON b.id = cbm.bot_id
      LEFT JOIN download_logs dl ON b.id = dl.bot_id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения ботов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить бота
app.post('/api/bots', authMiddleware, async (req, res) => {
  const { name, token, api_id, api_hash } = req.body;
  
  if (!name || !token || !api_id || !api_hash) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO bots (name, token, api_id, api_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, token, api_id, api_hash]
    );
    
    // Инициализируем нового бота сразу
    try {
      await initializeBotClient(result.rows[0]);
    } catch (error) {
      console.error('Ошибка инициализации бота:', error);
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      res.status(400).json({ error: 'Бот с таким токеном уже существует' });
    } else {
      console.error('Ошибка добавления бота:', error);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
});

// Обновить бота
app.put('/api/bots/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, token, api_id, api_hash, is_active } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE bots 
       SET name = $1, token = $2, api_id = $3, api_hash = $4, is_active = $5 
       WHERE id = $6 RETURNING *`,
      [name, token, api_id, api_hash, is_active, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Бот не найден' });
    }
    
    // Переинициализируем бота если он активен
    const botId = parseInt(id);
    if (is_active) {
      try {
        await initializeBotClient(result.rows[0]);
      } catch (error) {
        console.error('Ошибка переинициализации бота:', error);
      }
    } else {
      // Отключаем бота если он неактивен
      const bot = activeBots.get(botId);
      if (bot && bot.client && bot.client.connected) {
        await bot.client.disconnect();
        activeBots.delete(botId);
      }
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка обновления бота:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить бота
app.delete('/api/bots/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Отключаем бота перед удалением
    const botId = parseInt(id);
    const bot = activeBots.get(botId);
    if (bot && bot.client && bot.client.connected) {
      await bot.client.disconnect();
      activeBots.delete(botId);
    }
    
    const result = await pool.query('DELETE FROM bots WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Бот не найден' });
    }
    
    res.json({ message: 'Бот удален' });
  } catch (error) {
    console.error('Ошибка удаления бота:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить привязки каналов
app.get('/api/mappings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cbm.*, b.name as bot_name 
      FROM channel_bot_mapping cbm
      LEFT JOIN bots b ON cbm.bot_id = b.id
      ORDER BY cbm.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения привязок:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить/обновить привязку канала
app.post('/api/mappings', authMiddleware, async (req, res) => {
  const { chat_id, bot_id, channel_name, channel_username } = req.body;
  
  if (!chat_id || !bot_id) {
    return res.status(400).json({ error: 'chat_id и bot_id обязательны' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO channel_bot_mapping (chat_id, bot_id, channel_name, channel_username) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (chat_id) 
       DO UPDATE SET bot_id = $2, channel_name = $3, channel_username = $4
       RETURNING *`,
      [chat_id, bot_id, channel_name, channel_username]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка добавления привязки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить привязку
app.delete('/api/mappings/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query('DELETE FROM channel_bot_mapping WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Привязка не найдена' });
    }
    
    res.json({ message: 'Привязка удалена' });
  } catch (error) {
    console.error('Ошибка удаления привязки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить логи
app.get('/api/logs', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT dl.*, b.name as bot_name 
      FROM download_logs dl
      LEFT JOIN bots b ON dl.bot_id = b.id
      ORDER BY dl.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения логов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Редирект на админку
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ========== КОНЕЦ АДМИН ПАНЕЛИ ==========

// Запускаем сервер
startServer().catch(console.error);