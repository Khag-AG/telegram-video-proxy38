const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Директории
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

// Обслуживание статических файлов
app.use('/uploads', express.static(uploadDir));

// PostgreSQL подключение
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// JWT секрет
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Хранилище для клиентов ботов
const botClients = new Map();

// Инициализация базы данных
async function initDatabase() {
  try {
    // Таблица администраторов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица ботов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bots (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица привязок каналов к ботам
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_bot_mapping (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT UNIQUE NOT NULL,
        bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
        channel_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Создаем админа по умолчанию если его нет
    const adminExists = await pool.query('SELECT * FROM admins WHERE username = $1', ['admin']);
    if (adminExists.rows.length === 0) {
      const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
      const passwordHash = await bcrypt.hash(defaultPassword, 10);
      await pool.query(
        'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
        ['admin', passwordHash]
      );
      console.log(`📌 Создан администратор по умолчанию: admin / ${defaultPassword}`);
    }

    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
  }
}

// Middleware для проверки JWT токена
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Неверный токен' });
    }
    req.user = user;
    next();
  });
}

// Функция для получения или создания клиента бота
async function getBotClient(botToken) {
  if (botClients.has(botToken)) {
    return botClients.get(botToken);
  }

  try {
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;

    console.log(`🤖 Инициализация нового бота...`);

    const client = new TelegramClient(
      new StringSession(''),
      apiId,
      apiHash,
      {
        connectionRetries: 5,
        useWSS: false
      }
    );

    await client.start({
      botAuthToken: botToken,
      onError: (err) => console.error('Ошибка авторизации:', err),
    });

    const me = await client.getMe();
    console.log(`✅ Бот подключен: @${me.username} (ID: ${me.id})`);
    
    botClients.set(botToken, client);
    return client;
  } catch (error) {
    console.error('❌ Ошибка инициализации бота:', error);
    throw error;
  }
}

// Инициализация всех ботов при запуске
async function initializeBots() {
  try {
    const result = await pool.query('SELECT * FROM bots WHERE is_active = true');
    const bots = result.rows;
    
    console.log(`📋 Найдено ${bots.length} активных ботов`);
    
    for (const bot of bots) {
      try {
        await getBotClient(bot.token);
        console.log(`✅ Бот ${bot.name} инициализирован`);
      } catch (error) {
        console.error(`❌ Ошибка инициализации бота ${bot.name}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки ботов:', error);
  }
}

// ============ API ENDPOINTS ============

// Авторизация
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    const admin = result.rows[0];
    
    if (!admin || !await bcrypt.compare(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Неверные учетные данные' });
    }
    
    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET);
    res.json({ token, username: admin.username });
  } catch (error) {
    console.error('Ошибка авторизации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить список ботов
app.get('/api/bots', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bots ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения ботов' });
  }
});

// Добавить бота
app.post('/api/bots', authenticateToken, async (req, res) => {
  try {
    const { name, token } = req.body;
    
    // Проверяем токен
    const botClient = await getBotClient(token);
    const me = await botClient.getMe();
    
    // Сохраняем в БД
    const result = await pool.query(
      'INSERT INTO bots (name, token, username) VALUES ($1, $2, $3) RETURNING *',
      [name, token, me.username]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка добавления бота:', error);
    res.status(400).json({ error: 'Не удалось добавить бота. Проверьте токен.' });
  }
});

// Удалить бота
app.delete('/api/bots/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Получаем токен бота
    const botResult = await pool.query('SELECT token FROM bots WHERE id = $1', [id]);
    if (botResult.rows.length > 0) {
      const token = botResult.rows[0].token;
      
      // Отключаем клиент
      const client = botClients.get(token);
      if (client && client.connected) {
        await client.disconnect();
      }
      botClients.delete(token);
    }
    
    await pool.query('DELETE FROM bots WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка удаления бота' });
  }
});

// Получить привязки каналов
app.get('/api/mappings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, b.name as bot_name, b.username as bot_username 
      FROM channel_bot_mapping m
      JOIN bots b ON m.bot_id = b.id
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения привязок' });
  }
});

// Добавить привязку канала к боту
app.post('/api/mappings', authenticateToken, async (req, res) => {
  try {
    const { chat_id, bot_id, channel_name } = req.body;
    
    const result = await pool.query(
      'INSERT INTO channel_bot_mapping (chat_id, bot_id, channel_name) VALUES ($1, $2, $3) ON CONFLICT (chat_id) DO UPDATE SET bot_id = $2, channel_name = $3 RETURNING *',
      [chat_id, bot_id, channel_name]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка добавления привязки:', error);
    res.status(400).json({ error: 'Ошибка добавления привязки' });
  }
});

// Удалить привязку
app.delete('/api/mappings/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM channel_bot_mapping WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка удаления привязки' });
  }
});

// ============ ОСНОВНОЙ ФУНКЦИОНАЛ ============

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

    // Получаем бота для этого канала
    const mappingResult = await pool.query(
      'SELECT b.* FROM bots b JOIN channel_bot_mapping m ON b.id = m.bot_id WHERE m.chat_id = $1 AND b.is_active = true',
      [chat_id]
    );
    
    if (mappingResult.rows.length === 0) {
      return res.status(404).json({ 
        error: `Для канала ${chat_id} не найден привязанный бот. Добавьте привязку в админ-панели.` 
      });
    }
    
    const bot = mappingResult.rows[0];
    console.log(`🤖 Используется бот: ${bot.name} (@${bot.username})`);
    
    try {
      // Получаем клиент бота
      const botClient = await getBotClient(bot.token);
      
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
      // Создаем безопасное имя файла для URL
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
      
      // Отправляем ответ в формате для Make.com
      res.json({
        fileName: originalFileName,
        safeFileName: safeFileName,
        filePath: `videos/${originalFileName}`,
        fileUrl: directUrl,
        fileSize: stats.size,
        fileSizeMB: fileSizeMB.toFixed(2),
        botUsed: bot.name,
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

// ============ АДМИН ПАНЕЛЬ (HTML) ============

app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Админ панель - Telegram Video Proxy</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            color: #333;
        }
        
        .login-container {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .login-form {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 400px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 1rem;
        }
        
        .header {
            background: white;
            padding: 1rem 0;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 2rem;
        }
        
        .header-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        h1, h2 {
            color: #0088cc;
        }
        
        .card {
            background: white;
            padding: 1.5rem;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 1.5rem;
        }
        
        .form-group {
            margin-bottom: 1rem;
        }
        
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
        }
        
        input, select {
            width: 100%;
            padding: 0.5rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 1rem;
        }
        
        button {
            background: #0088cc;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1rem;
            transition: background 0.2s;
        }
        
        button:hover {
            background: #0077b5;
        }
        
        button.danger {
            background: #dc3545;
        }
        
        button.danger:hover {
            background: #c82333;
        }
        
        .table {
            width: 100%;
            border-collapse: collapse;
        }
        
        .table th, .table td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        
        .table th {
            background: #f8f9fa;
            font-weight: 600;
        }
        
        .bot-status {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 0.5rem;
        }
        
        .bot-status.active {
            background: #28a745;
        }
        
        .bot-status.inactive {
            background: #dc3545;
        }
        
        .alert {
            padding: 1rem;
            border-radius: 4px;
            margin-bottom: 1rem;
        }
        
        .alert.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .alert.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        #app {
            display: none;
        }
        
        .tabs {
            display: flex;
            gap: 1rem;
            margin-bottom: 2rem;
            border-bottom: 2px solid #ddd;
        }
        
        .tab {
            padding: 0.75rem 1.5rem;
            background: none;
            border: none;
            color: #666;
            cursor: pointer;
            position: relative;
            transition: color 0.2s;
        }
        
        .tab.active {
            color: #0088cc;
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: #0088cc;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
    </style>
</head>
<body>
    <!-- Login Form -->
    <div id="loginForm" class="login-container">
        <div class="login-form">
            <h2 style="margin-bottom: 1.5rem; text-align: center;">Вход в админ панель</h2>
            <form id="loginFormElement">
                <div class="form-group">
                    <label>Логин</label>
                    <input type="text" id="username" required>
                </div>
                <div class="form-group">
                    <label>Пароль</label>
                    <input type="password" id="password" required>
                </div>
                <button type="submit" style="width: 100%;">Войти</button>
            </form>
        </div>
    </div>

    <!-- Main App -->
    <div id="app">
        <div class="header">
            <div class="container">
                <div class="header-content">
                    <h1>Telegram Video Proxy - Админ панель</h1>
                    <button onclick="logout()" class="danger">Выйти</button>
                </div>
            </div>
        </div>

        <div class="container">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('bots')">Боты</button>
                <button class="tab" onclick="switchTab('mappings')">Привязки каналов</button>
            </div>

            <!-- Bots Tab -->
            <div id="botsTab" class="tab-content active">
                <div class="card">
                    <h2>Добавить бота</h2>
                    <form id="addBotForm">
                        <div class="form-group">
                            <label>Название бота</label>
                            <input type="text" id="botName" placeholder="Например: Бот для клиента 1" required>
                        </div>
                        <div class="form-group">
                            <label>Токен бота</label>
                            <input type="text" id="botToken" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz" required>
                        </div>
                        <button type="submit">Добавить бота</button>
                    </form>
                </div>

                <div class="card">
                    <h2>Список ботов</h2>
                    <div id="botsList"></div>
                </div>
            </div>

            <!-- Mappings Tab -->
            <div id="mappingsTab" class="tab-content">
                <div class="card">
                    <h2>Добавить привязку канала</h2>
                    <form id="addMappingForm">
                        <div class="form-group">
                            <label>Chat ID канала</label>
                            <input type="number" id="chatId" placeholder="-1002397627160" required>
                        </div>
                        <div class="form-group">
                            <label>Название канала</label>
                            <input type="text" id="channelName" placeholder="Название для удобства" required>
                        </div>
                        <div class="form-group">
                            <label>Бот</label>
                            <select id="botSelect" required>
                                <option value="">Выберите бота</option>
                            </select>
                        </div>
                        <button type="submit">Добавить привязку</button>
                    </form>
                </div>

                <div class="card">
                    <h2>Список привязок</h2>
                    <div id="mappingsList"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('adminToken');
        let currentTab = 'bots';

        // Check auth
        if (token) {
            showApp();
        }

        // Login
        document.getElementById('loginFormElement').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ username, password })
                });
                
                if (!response.ok) {
                    throw new Error('Неверные учетные данные');
                }
                
                const data = await response.json();
                token = data.token;
                localStorage.setItem('adminToken', token);
                showApp();
            } catch (error) {
                alert(error.message);
            }
        });

        function showApp() {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('app').style.display = 'block';
            loadBots();
            loadMappings();
        }

        function logout() {
            localStorage.removeItem('adminToken');
            location.reload();
        }

        function switchTab(tab) {
            currentTab = tab;
            
            // Update tabs
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            
            if (tab === 'bots') {
                document.querySelector('.tab:nth-child(1)').classList.add('active');
                document.getElementById('botsTab').classList.add('active');
                loadBots();
            } else {
                document.querySelector('.tab:nth-child(2)').classList.add('active');
                document.getElementById('mappingsTab').classList.add('active');
                loadMappings();
            }
        }

        // Add bot
        document.getElementById('addBotForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('botName').value;
            const botToken = document.getElementById('botToken').value;
            
            try {
                const response = await fetch('/api/bots', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ name, token: botToken })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error);
                }
                
                document.getElementById('botName').value = '';
                document.getElementById('botToken').value = '';
                loadBots();
                alert('Бот успешно добавлен!');
            } catch (error) {
                alert(error.message);
            }
        });

        // Add mapping
        document.getElementById('addMappingForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const chat_id = document.getElementById('chatId').value;
            const channel_name = document.getElementById('channelName').value;
            const bot_id = document.getElementById('botSelect').value;
            
            try {
                const response = await fetch('/api/mappings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ chat_id, channel_name, bot_id })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error);
                }
                
                document.getElementById('chatId').value = '';
                document.getElementById('channelName').value = '';
                document.getElementById('botSelect').value = '';
                loadMappings();
                alert('Привязка успешно добавлена!');
            } catch (error) {
                alert(error.message);
            }
        });

        async function loadBots() {
            try {
                const response = await fetch('/api/bots', {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });
                
                const bots = await response.json();
                
                // Update bots list
                const botsList = document.getElementById('botsList');
                if (bots.length === 0) {
                    botsList.innerHTML = '<p>Нет добавленных ботов</p>';
                } else {
                    botsList.innerHTML = \`
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Статус</th>
                                    <th>Название</th>
                                    <th>Username</th>
                                    <th>Токен</th>
                                    <th>Добавлен</th>
                                    <th>Действия</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${bots.map(bot => \`
                                    <tr>
                                        <td><span class="bot-status \${bot.is_active ? 'active' : 'inactive'}"></span></td>
                                        <td>\${bot.name}</td>
                                        <td>@\${bot.username || 'N/A'}</td>
                                        <td>\${bot.token.substring(0, 20)}...</td>
                                        <td>\${new Date(bot.created_at).toLocaleString()}</td>
                                        <td>
                                            <button class="danger" onclick="deleteBot(\${bot.id})">Удалить</button>
                                        </td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    \`;
                }
                
                // Update bot select
                const botSelect = document.getElementById('botSelect');
                botSelect.innerHTML = '<option value="">Выберите бота</option>' +
                    bots.map(bot => \`<option value="\${bot.id}">\${bot.name} (@\${bot.username})</option>\`).join('');
                    
            } catch (error) {
                console.error('Error loading bots:', error);
            }
        }

        async function loadMappings() {
            try {
                const response = await fetch('/api/mappings', {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });
                
                const mappings = await response.json();
                
                const mappingsList = document.getElementById('mappingsList');
                if (mappings.length === 0) {
                    mappingsList.innerHTML = '<p>Нет привязок каналов</p>';
                } else {
                    mappingsList.innerHTML = \`
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Chat ID</th>
                                    <th>Канал</th>
                                    <th>Бот</th>
                                    <th>Добавлена</th>
                                    <th>Действия</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${mappings.map(mapping => \`
                                    <tr>
                                        <td>\${mapping.chat_id}</td>
                                        <td>\${mapping.channel_name}</td>
                                        <td>\${mapping.bot_name} (@\${mapping.bot_username})</td>
                                        <td>\${new Date(mapping.created_at).toLocaleString()}</td>
                                        <td>
                                            <button class="danger" onclick="deleteMapping(\${mapping.id})">Удалить</button>
                                        </td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    \`;
                }
            } catch (error) {
                console.error('Error loading mappings:', error);
            }
        }

        async function deleteBot(id) {
            if (!confirm('Вы уверены, что хотите удалить этого бота?')) return;
            
            try {
                const response = await fetch('/api/bots/' + id, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });
                
                if (!response.ok) {
                    throw new Error('Ошибка удаления бота');
                }
                
                loadBots();
            } catch (error) {
                alert(error.message);
            }
        }

        async function deleteMapping(id) {
            if (!confirm('Вы уверены, что хотите удалить эту привязку?')) return;
            
            try {
                const response = await fetch('/api/mappings/' + id, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });
                
                if (!response.ok) {
                    throw new Error('Ошибка удаления привязки');
                }
                
                loadMappings();
            } catch (error) {
                alert(error.message);
            }
        }
    </script>
</body>
</html>
  `);
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    server: 'Telegram Bot Video Proxy',
    version: '5.0.0',
    features: ['Multi-bot support', 'Admin panel', 'PostgreSQL storage']
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    uptime: process.uptime(),
    bots: botClients.size
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
  await initDatabase();
  await initializeBots();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📡 Эндпоинты:`);
    console.log(`   POST /download-bot - Скачивание файлов через бота`);
    console.log(`   GET  /admin        - Админ панель`);
    console.log(`   GET  /health       - Проверка состояния\n`);
    console.log(`🔐 Админ панель: /admin`);
    console.log(`   Логин: admin`);
    console.log(`   Пароль: ${process.env.ADMIN_PASSWORD || 'admin123'}\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Останавливаем сервер...');
  
  // Отключаем всех ботов
  for (const [token, client] of botClients) {
    if (client && client.connected) {
      await client.disconnect();
    }
  }
  
  // Закрываем пул соединений с БД
  await pool.end();
  
  process.exit(0);
});

// Запускаем сервер
startServer().catch(console.error);