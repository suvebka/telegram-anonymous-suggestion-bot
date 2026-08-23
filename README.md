# Анонимная предложка для Telegram на Cloudflare Workers

Этот проект создаёт Telegram-бота для анонимных предложений.

Пользователь пишет боту в личные сообщения. Бот копирует сообщение в закрытую
группу модерации без имени отправителя. Модератор выбирает тег, при желании
добавляет комментарий ответом на сообщение предложки, а затем публикует запись
в канал.

Поддерживаются:

- текст;
- фотографии с подписью;
- видео с подписью;
- документы, аудио, голосовые и стикеры;
- альбомы фотографий/видео;
- теги перед публикацией;
- комментарий модератора внутри итогового поста.

Бот работает на Cloudflare Workers через Telegram webhook, поэтому компьютер
после настройки держать включённым не нужно.

## Важная модель анонимности

Бот копирует сообщение, а не пересылает его. Поэтому Telegram не добавляет
профиль автора к публикации. Однако Telegram, модераторы и владелец Cloudflare
аккаунта всё равно могут видеть содержимое в соответствующих чатах. Это не
сквозное шифрование. Не обещайте пользователям абсолютную анонимность.

## Что понадобится

- аккаунт Telegram;
- аккаунт GitHub для публикации кода;
- аккаунт Cloudflare;
- Node.js LTS, рекомендуется версия 20 или новее;
- бот, созданный через `@BotFather`;
- закрытая группа модерации;
- канал, где бот сможет публиковать записи.

## Этап 1. Создать Telegram-бота

1. Откройте в Telegram `@BotFather`.
2. Отправьте команду `/newbot`.
3. Введите отображаемое имя бота, например `Anonymous Suggestions`.
4. Введите username, который заканчивается на `bot`, например
   `my_anonymous_suggestions_bot`.
5. `@BotFather` выдаст токен вида:

   ```text
   123456789:AAExampleToken
   ```

   Сохраните его локально. **Не публикуйте токен в GitHub, чате или скриншоте.**
   Если токен утёк, откройте `@BotFather`, выполните `/revoke`, выберите бота и
   получите новый токен.

6. По желанию настройте описание бота через `/setdescription` и текст кнопки
   запуска через `/setabouttext`.

## Этап 2. Подготовить Telegram-чаты

### Группа модерации

1. Создайте закрытую группу.
2. Добавьте туда бота.
3. Сделайте бота администратором. Это нужно, чтобы он мог копировать сообщения,
   отправлять служебные сообщения и обрабатывать кнопки.

### Публичный канал

1. Создайте канал или выберите существующий.
2. Добавьте бота администратором.
3. Включите право публикации сообщений.

### Как получить ID

Для группы и канала нужны числовые ID. Удобный способ:

1. Добавьте временно бота вроде `@RawDataBot` или другого доверенного бота,
   который показывает JSON Telegram-сообщений.
2. Отправьте сообщение в нужную группу/канал.
3. Найдите поле `chat.id`.
4. Для групп и каналов ID обычно выглядит так:

   ```text
   -1001234567890
   ```

   Важно сохранить минус и префикс `-100`. ID пользователя, которому разрешена
   публикация, обычно положительный, например `123456789`.

5. Удалите информационного бота после получения ID.

## Этап 3. Установить Node.js и Wrangler

Установите Node.js LTS с официального сайта:

```text
https://nodejs.org/
```

Проверьте установку в PowerShell:

```powershell
node --version
npm --version
```

В папке проекта установите зависимости:

```powershell
cd путь\к\telegram-anonymous-suggestion-bot
npm install
npm run check
```

## Этап 4. Создать аккаунт Cloudflare

1. Откройте `https://dash.cloudflare.com/`.
2. Зарегистрируйтесь или войдите через GitHub.
3. Для этого проекта домен покупать не нужно: Worker будет доступен на адресе
   `https://имя-бота.имя-аккаунта.workers.dev`.

Авторизуйте Wrangler:

```powershell
npx wrangler login
```

Откроется браузер. Разрешите Wrangler доступ к Cloudflare и вернитесь в
PowerShell.

## Этап 5. Создать KV для очереди модерации

Выполните:

```powershell
npx wrangler kv namespace create SUGGESTIONS
```

Команда напечатает ID, например:

```text
id = "0123456789abcdef0123456789abcdef"
```

Откройте `wrangler.toml` и замените только значение:

```toml
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

на полученный ID.

KV хранит временные данные предложек, выбранные теги и комментарии модерации.

## Этап 6. Настроить Durable Object для альбомов

В `wrangler.toml` уже есть этот блок:

```toml
[[durable_objects.bindings]]
name = "ALBUMS"
class_name = "AlbumCoordinator"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AlbumCoordinator"]
```

Он нужен, чтобы несколько фотографий из одного Telegram-альбома собирались в
одну публикацию. Ничего менять в этом блоке не нужно.

## Этап 7. Создать секреты Cloudflare

Выполните команды по очереди. Wrangler будет интерактивно просить значение.
Не вставляйте секреты прямо в команду и не записывайте их в GitHub.

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put MODERATION_CHAT_ID
npx wrangler secret put PUBLIC_CHANNEL_ID
npx wrangler secret put ADMIN_IDS
npx wrangler secret put WEBHOOK_SECRET
```

### Что вводить для каждого секрета

#### `BOT_TOKEN`

Вставьте токен, который выдал `@BotFather`.

#### `MODERATION_CHAT_ID`

Вставьте ID закрытой группы, например:

```text
-1001234567890
```

#### `PUBLIC_CHANNEL_ID`

Вставьте ID канала, например:

```text
-1009876543210
```

#### `ADMIN_IDS`

Вставьте положительные ID пользователей, которым разрешено нажимать кнопки:

```text
123456789,987654321
```

Это ID людей, не ID группы. ID группы начинается с минуса.

#### `WEBHOOK_SECRET`

Это случайная длинная строка, которая защищает входящий webhook. Сгенерировать
её в PowerShell можно так:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

Скопируйте результат и вставьте его как значение `WEBHOOK_SECRET`. Никому не
показывайте эту строку. Она будет использоваться в URL webhook и заголовке
запросов Telegram.

## Этап 8. Опубликовать Worker

Проверьте код и выполните деплой:

```powershell
npm run check
npx wrangler deploy
```

При первом деплое Wrangler может спросить, создавать ли `workers.dev`
поддомен. Ответьте `yes`, затем введите имя только из латиницы, цифр и дефисов,
например:

```text
my-anonymous-suggestions
```

Не вставляйте туда команду PowerShell или URL.

После деплоя Wrangler покажет адрес Worker, например:

```text
https://telegram-anonymous-suggestion-bot.my-account.workers.dev
```

Скопируйте этот адрес без завершающего слеша.

## Этап 9. Установить Telegram webhook

Запустите в PowerShell, заменив значения в первых трёх строках:

```powershell
$botToken = "ТОКЕН_ОТ_BOTFATHER"
$secret = "ВАШ_WEBHOOK_SECRET"
$worker = "https://telegram-anonymous-suggestion-bot.ваш-аккаунт.workers.dev"

$body = @{
    url = "$worker/webhook/$secret"
    secret_token = $secret
    drop_pending_updates = $true
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "https://api.telegram.org/bot$botToken/setWebhook" `
    -ContentType "application/json" `
    -Body $body
```

Успешный ответ содержит:

```json
{
  "ok": true,
  "result": true
}
```

Если `api.telegram.org` недоступен из вашей сети, установите webhook через
защищённый endpoint самого Worker:

```powershell
$secret = "ВАШ_WEBHOOK_SECRET"
$worker = "https://telegram-anonymous-suggestion-bot.ваш-аккаунт.workers.dev"

Invoke-RestMethod `
    -Method Post `
    -Uri "$worker/admin/set-webhook" `
    -Headers @{ "X-Setup-Secret" = $secret }
```

Этот запрос выполняет вызов Telegram из Cloudflare, а не с вашего компьютера.

Проверить webhook можно в Cloudflare через защищённую диагностику:

```powershell
Invoke-RestMethod `
    -Uri "$worker/admin/diagnostics" `
    -Headers @{ "X-Setup-Secret" = $secret }
```

Не публикуйте полный URL webhook: в нём находится секретный путь.

## Этап 10. Как пользоваться модерацией

1. Пользователь отправляет сообщение боту.
2. В группе модерации появляется копия и кнопки **Одобрить** / **Отклонить**.
3. Нажмите **Одобрить**.
4. Выберите тег.
5. Нажмите **Комментарий**, если нужно добавить мнение модератора.
6. Отправьте текст комментария **ответом на скопированное сообщение предложки**.
7. Нажмите **Опубликовать**.

Итоговый текст будет выглядеть так:

```text
#предложка

Текст подписчика

От модерации:
Мнение модератора
```

## Как добавить свои теги

Откройте `src/index.js` и найдите начало файла:

```javascript
const TAGS = [
  "#предложка",
  "#вопрос",
  "#история",
  "#совет",
  "#обсуждение",
];
```

Замените или добавьте строки. Например:

```javascript
const TAGS = [
  "#новости",
  "#вопрос",
  "#мемы",
  "#важное",
];
```

Каждый тег должен быть отдельной строкой в кавычках. После изменения выполните:

```powershell
npm run check
npx wrangler deploy
```

Кнопки обновятся автоматически после нового деплоя.

## Как изменить подпись к комментарию

В `src/index.js` найдите:

```javascript
const MODERATOR_SIGNATURE = "От модерации:";
```

Например, можно заменить на:

```javascript
const MODERATOR_SIGNATURE = "Мнение редакции:";
```

Или:

```javascript
const MODERATOR_SIGNATURE = "Ответ администрации:";
```

После этого снова выполните:

```powershell
npm run check
npx wrangler deploy
```

## Обновление секретов

Если нужно поменять ID группы, канала или список модераторов, повторите нужную
команду:

```powershell
npx wrangler secret put MODERATION_CHAT_ID
npx wrangler secret put PUBLIC_CHANNEL_ID
npx wrangler secret put ADMIN_IDS
```

Если токен утёк, сначала отзовите его в `@BotFather`, получите новый и выполните:

```powershell
npx wrangler secret put BOT_TOKEN
```

Затем установите webhook заново.

## Локальная проверка

Проверить синтаксис можно так:

```powershell
npm run check
```

Проверить последние логи Worker:

```powershell
npx wrangler tail
```

Не публикуйте логи, если в них есть секретный URL webhook или личные данные.

## GitHub

Перед публикацией убедитесь, что в репозитории нет:

- `.env`;
- токена Telegram;
- `WEBHOOK_SECRET`;
- реальных ID групп, каналов и администраторов;
- `node_modules`;
- `.wrangler`.

Создайте новый репозиторий на `https://github.com/new`, например
`telegram-anonymous-suggestion-bot`. Затем в PowerShell из папки проекта:

```powershell
git init
git add .
git commit -m "Initial anonymous Telegram suggestion bot"
git branch -M main
git remote add origin https://github.com/ВАШ_GITHUB/telegram-anonymous-suggestion-bot.git
git push -u origin main
```

Если GitHub спросит пароль, используйте Personal Access Token или GitHub CLI,
а не пароль от аккаунта.

После публикации другие люди смогут склонировать проект:

```powershell
git clone https://github.com/ВАШ_GITHUB/telegram-anonymous-suggestion-bot.git
cd telegram-anonymous-suggestion-bot
npm install
```

Каждый пользователь должен создать свои Cloudflare KV, свои секреты, своего
Telegram-бота и свой webhook. Не используйте чужие токены, ID или namespace.

## Лицензия

Если хотите разрешить свободное использование кода, добавьте файл `LICENSE`,
например с лицензией MIT.
