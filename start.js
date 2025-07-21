// start.js
const { spawn } = require('child_process');

console.log('🚀 Запуск Multi-Bot системы...');

// Запускаем основной сервер
const botServer = spawn('node', ['bot-server.js'], {
  stdio: 'inherit',
  env: process.env
});

// Запускаем админ панель
const adminPanel = spawn('node', ['admin-panel.js'], {
  stdio: 'inherit',
  env: process.env
});

// Обработка завершения
process.on('SIGINT', () => {
  console.log('🛑 Останавливаем серверы...');
  botServer.kill();
  adminPanel.kill();
  process.exit();
});