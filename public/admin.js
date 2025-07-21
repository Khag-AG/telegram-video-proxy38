let authToken = localStorage.getItem('adminToken');
let bots = [];

// В начале файла добавьте:
const API_BASE = window.location.hostname === 'localhost' 
  ? 'http://localhost:3001' 
  : 'https://telegram-video-proxy38-production.up.railway.app:3001';

// И замените все fetch запросы, например:
const response = await fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
});

// Проверка авторизации при загрузке
document.addEventListener('DOMContentLoaded', () => {
    if (authToken) {
        showAdminPanel();
        loadBots();
        loadMappings();
        loadLogs();
    } else {
        showLoginForm();
    }

    // Обработчики событий
    document.getElementById('loginFormElement').addEventListener('submit', handleLogin);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('addBotBtn').addEventListener('click', () => openBotModal());
    document.getElementById('addMappingBtn').addEventListener('click', () => openMappingModal());
    document.getElementById('botForm').addEventListener('submit', handleSaveBot);
    document.getElementById('mappingForm').addEventListener('submit', handleSaveMapping);

    // Переключение вкладок
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
});

// Функции авторизации
async function handleLogin(e) {
    e.preventDefault();
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();
        
        if (response.ok) {
            authToken = data.token;
            localStorage.setItem('adminToken', authToken);
            showAdminPanel();
            loadBots();
            loadMappings();
            loadLogs();
        } else {
            alert(data.error || 'Ошибка входа');
        }
    } catch (error) {
        alert('Ошибка подключения к серверу');
    }
}

function handleLogout() {
    authToken = null;
    localStorage.removeItem('adminToken');
    showLoginForm();
}

function showLoginForm() {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('adminPanel').style.display = 'none';
}

function showAdminPanel() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
}

// Переключение вкладок
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${tabName}Tab`);
    });
}

// Работа с ботами
async function loadBots() {
    try {
        const response = await fetch('/api/bots', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            bots = await response.json();
            renderBotsTable();
            updateBotSelect();
        }
    } catch (error) {
        console.error('Ошибка загрузки ботов:', error);
    }
}

function renderBotsTable() {
    const tbody = document.querySelector('#botsTable tbody');
    tbody.innerHTML = bots.map(bot => `
        <tr>
            <td>${bot.id}</td>
            <td>${bot.name}</td>
            <td>${bot.api_id}</td>
            <td>${bot.channels_count || 0}</td>
            <td>${bot.downloads_count || 0}</td>
            <td><span class="status ${bot.is_active ? 'active' : 'inactive'}">${bot.is_active ? 'Активен' : 'Неактивен'}</span></td>
            <td>
                <button class="btn-edit" onclick="editBot(${bot.id})">Изменить</button>
                <button class="btn-danger" onclick="deleteBot(${bot.id})">Удалить</button>
            </td>
        </tr>
    `).join('');
}

function openBotModal(botId = null) {
    const modal = document.getElementById('botModal');
    const title = document.getElementById('botModalTitle');
    
    if (botId) {
        const bot = bots.find(b => b.id === botId);
        title.textContent = 'Редактировать бота';
        document.getElementById('botId').value = bot.id;
        document.getElementById('botName').value = bot.name;
        document.getElementById('botToken').value = bot.token;
        document.getElementById('botApiId').value = bot.api_id;
        document.getElementById('botApiHash').value = bot.api_hash;
        document.getElementById('botIsActive').checked = bot.is_active;
    } else {
        title.textContent = 'Добавить бота';
        document.getElementById('botForm').reset();
        document.getElementById('botId').value = '';
    }
    
    modal.style.display = 'block';
}

function closeBotModal() {
    document.getElementById('botModal').style.display = 'none';
}

function editBot(id) {
    openBotModal(id);
}

async function handleSaveBot(e) {
    e.preventDefault();
    
    const botId = document.getElementById('botId').value;
    const botData = {
        name: document.getElementById('botName').value,
        token: document.getElementById('botToken').value,
        api_id: parseInt(document.getElementById('botApiId').value),
        api_hash: document.getElementById('botApiHash').value,
        is_active: document.getElementById('botIsActive').checked
    };
    
    try {
        const url = botId ? `/api/bots/${botId}` : '/api/bots';
        const method = botId ? 'PUT' : 'POST';
        
        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(botData)
        });
        
        if (response.ok) {
            closeBotModal();
            loadBots();
            alert(botId ? 'Бот обновлен' : 'Бот добавлен');
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка сохранения');
        }
    } catch (error) {
        alert('Ошибка подключения к серверу');
    }
}

async function deleteBot(id) {
    if (!confirm('Удалить бота? Это также удалит все привязки и логи.')) return;
    
    try {
        const response = await fetch(`/api/bots/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            loadBots();
            loadMappings();
            alert('Бот удален');
        }
    } catch (error) {
        alert('Ошибка удаления');
    }
}

// Работа с привязками
async function loadMappings() {
    try {
        const response = await fetch('/api/mappings', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const mappings = await response.json();
            renderMappingsTable(mappings);
        }
    } catch (error) {
        console.error('Ошибка загрузки привязок:', error);
    }
}

function renderMappingsTable(mappings) {
    const tbody = document.querySelector('#mappingsTable tbody');
    tbody.innerHTML = mappings.map(mapping => `
        <tr>
            <td>${mapping.chat_id}</td>
            <td>${mapping.channel_name || '-'}</td>
            <td>${mapping.channel_username || '-'}</td>
            <td>${mapping.bot_name || 'Не назначен'}</td>
            <td>${new Date(mapping.created_at).toLocaleString('ru')}</td>
            <td>
                <button class="btn-danger" onclick="deleteMapping(${mapping.id})">Удалить</button>
            </td>
        </tr>
    `).join('');
}

function openMappingModal() {
    document.getElementById('mappingForm').reset();
    document.getElementById('mappingModal').style.display = 'block';
}

function closeMappingModal() {
    document.getElementById('mappingModal').style.display = 'none';
}

function updateBotSelect() {
    const select = document.getElementById('mappingBotId');
    select.innerHTML = '<option value="">Выберите бота</option>' + 
        bots.filter(bot => bot.is_active).map(bot => 
            `<option value="${bot.id}">${bot.name}</option>`
        ).join('');
}

async function handleSaveMapping(e) {
    e.preventDefault();
    
    const mappingData = {
        chat_id: parseInt(document.getElementById('mappingChatId').value),
        bot_id: parseInt(document.getElementById('mappingBotId').value),
        channel_name: document.getElementById('mappingChannelName').value,
        channel_username: document.getElementById('mappingChannelUsername').value
    };
    
    try {
        const response = await fetch('/api/mappings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(mappingData)
        });
        
        if (response.ok) {
            closeMappingModal();
            loadMappings();
            alert('Привязка сохранена');
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка сохранения');
        }
    } catch (error) {
        alert('Ошибка подключения к серверу');
    }
}

async function deleteMapping(id) {
    if (!confirm('Удалить привязку?')) return;
    
    try {
        const response = await fetch(`/api/mappings/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            loadMappings();
            alert('Привязка удалена');
        }
    } catch (error) {
        alert('Ошибка удаления');
    }
}

// Работа с логами
async function loadLogs() {
    try {
        const response = await fetch('/api/logs', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
            const logs = await response.json();
            renderLogsTable(logs);
        }
    } catch (error) {
        console.error('Ошибка загрузки логов:', error);
    }
}

function renderLogsTable(logs) {
    const tbody = document.querySelector('#logsTable tbody');
    tbody.innerHTML = logs.map(log => `
        <tr>
            <td>${new Date(log.created_at).toLocaleString('ru')}</td>
            <td>${log.chat_id || '-'}</td>
            <td>${log.bot_name || '-'}</td>
            <td>${log.file_name || '-'}</td>
            <td>${log.file_size ? formatFileSize(log.file_size) : '-'}</td>
            <td><span class="status ${log.status === 'success' ? 'success' : 'error'}">${log.status}</span></td>
        </tr>
    `).join('');
}

function formatFileSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Закрытие модалок по клику вне
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
}