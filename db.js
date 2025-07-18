const { Pool } = require('pg');
require('dotenv').config();

// Используем DATABASE_URL от Railway или локальные настройки
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Инициализация таблиц
async function initDatabase() {
  try {
    // Таблица ботов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bots (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL UNIQUE,
        api_id INTEGER NOT NULL,
        api_hash VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица привязки каналов к ботам
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_bot_mapping (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL UNIQUE,
        bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
        channel_name VARCHAR(255),
        channel_username VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица логов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS download_logs (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT,
        bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
        file_name VARCHAR(255),
        file_size BIGINT,
        status VARCHAR(50),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ База данных инициализирована');
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
    throw error;
  }
}

module.exports = {
  pool,
  initDatabase
};