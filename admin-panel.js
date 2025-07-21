const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { pool, initDatabase } = require('./db');
require('dotenv').config();

const app = express();
const PORT = 3001; // Фиксированный порт для админки
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-me';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  // В реальном приложении храните хэш пароля в БД
  const isValid = await bcrypt.compare(password, await bcrypt.hash(ADMIN_PASSWORD, 10));
  
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

// Запуск сервера
async function startAdminPanel() {
  await initDatabase();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🔧 Админ панель запущена на порту ${PORT}`);
    console.log(`📡 Доступ: http://localhost:${PORT}`);
    console.log(`🔑 Пароль: ${ADMIN_PASSWORD}\n`);
  });
}

startAdminPanel().catch(console.error);