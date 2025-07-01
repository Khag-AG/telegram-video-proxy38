const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
require('dotenv').config();

async function createTestSession() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    
    console.log('API ID:', apiId);
    console.log('API Hash:', apiHash ? 'Установлен' : 'НЕ УСТАНОВЛЕН');
    
    const stringSession = new StringSession('');
    
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });
    
    try {
        await client.start({
            phoneNumber: async () => await input.text('Введите номер телефона: '),
            phoneCode: async () => await input.text('Введите код из Telegram: '),
            password: async () => await input.text('Введите пароль 2FA (если нет - просто Enter): '),
            onError: (err) => console.log(err),
        });
        
        console.log('\n✅ Успешно подключились!');
        
        const sessionString = client.session.save();
        console.log('\n📝 Сохраните эту строку сессии:');
        console.log(sessionString);
        
        // Проверяем доступ к каналу
        const channelUsername = await input.text('\nВведите username канала (с @): ');
        
        try {
            const channel = await client.getEntity(channelUsername);
            console.log(`\n✅ Канал ${channel.title} найден!`);
        } catch (err) {
            console.log('\n❌ Канал не найден:', err.message);
        }
        
        await client.disconnect();
        
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

createTestSession();