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
    const { file_id, file_name } = req.body;
    
    console.log(`📥 Запрос на скачивание файла по file_id: ${file_id}`);
    
    if (!file_id) {
      return res.status(400).json({ 
        error: 'Необходимо указать file_id' 
      });
    }

    try {
      // Получаем информацию о файле через Bot API
      const fileInfo = await botClient.invoke(
        new Api.upload.GetFile({
          location: new Api.InputDocumentFileLocation({
            id: BigInt(file_id.split('_')[0]),
            accessHash: BigInt(0),
            fileReference: Buffer.from(file_id, 'base64'),
            thumbSize: ''
          }),
          offset: BigInt(0),
          limit: 1024 * 1024
        })
      );
      
      console.log('File info:', fileInfo);
      
    } catch (e) {
      // Если не получилось через MTProto, пробуем через HTTP API
      console.log('Пробуем через HTTP API...');
      
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      
      // Получаем путь к файлу
      const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${file_id}`;
      const fileResponse = await fetch(getFileUrl);
      const fileData = await fileResponse.json();
      
      if (!fileData.ok) {
        return res.status(400).json({ 
          error: 'Не удалось получить информацию о файле',
          details: fileData.description 
        });
      }
      
      console.log('File path:', fileData.result.file_path);
      
      // Скачиваем файл
      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
      const downloadResponse = await fetch(downloadUrl);
      
      if (!downloadResponse.ok) {
        return res.status(400).json({ 
          error: 'Не удалось скачать файл' 
        });
      }
      
      const buffer = Buffer.from(await downloadResponse.arrayBuffer());
      
      // Генерируем имя файла
      const fileName = file_name || `file_${Date.now()}.bin`;
      const uploadId = uuidv4();
      const tempFileName = `${uploadId}_${fileName}`;
      const localPath = path.join(uploadDir, tempFileName);
      
      // Сохраняем файл
      await fs.writeFile(localPath, buffer);
      console.log(`💾 Файл сохранен: ${localPath}`);
      
      const stats = await fs.stat(localPath);
      
      // Для файлов меньше 95MB - возвращаем напрямую
      if (stats.size < 95 * 1024 * 1024) {
        res.setHeader('Content-Type', 'application/octet-stream');
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
          exp: Date.now() + (30 * 60 * 1000) // 30 минут
        })).toString('base64');
        
        const baseUrl = `https://${req.get('host')}`;
        
        res.json({
          success: true,
          fileName: fileName,
          fileSize: stats.size,
          fileSizeMB: (stats.size / 1024 / 1024).toFixed(2),
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