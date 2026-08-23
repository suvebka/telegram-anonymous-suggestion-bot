const COOLDOWN_SECONDS = 20;
const TELEGRAM_TIMEOUT_MS = 10000;
const ALBUM_WAIT_MS = 2500;
const TAGS = [
  "#предложка",
  "#вопрос",
  "#история",
  "#совет",
  "#обсуждение",
];
const MAX_COMMENT_LENGTH = 1000;
const MODERATOR_SIGNATURE = "От модерации:";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function configError(env) {
  return ["BOT_TOKEN", "MODERATION_CHAT_ID", "PUBLIC_CHANNEL_ID", "WEBHOOK_SECRET", "SUGGESTIONS", "ALBUMS"]
    .filter((name) => !env[name])
    .join(", ");
}

async function telegram(env, method, parameters) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(env.BOT_TOKEN)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parameters),
      signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || !payload?.ok) {
      const description = payload?.description || `HTTP ${response.status}`;
      const error = new Error(`Telegram ${method} failed: ${description}`);
      error.telegramParameters = payload?.parameters;
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function adminIds(env) {
  return new Set((env.ADMIN_IDS || "")
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean));
}

function isAdmin(userId, env) {
  const ids = adminIds(env);
  return ids.size === 0 || ids.has(String(userId));
}

async function isModerator(userId, env) {
  if (isAdmin(userId, env)) return true;
  try {
    const member = await telegram(env, "getChatMember", {
      chat_id: await moderationChatId(env),
      user_id: userId,
    });
    return member?.status === "creator" || member?.status === "administrator";
  } catch (error) {
    console.error("moderator lookup failed", error);
    return false;
  }
}

function submissionId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
}

function initialModerationMarkup(id) {
  return { inline_keyboard: [[
    { text: "✅ Одобрить", callback_data: `approve:${id}` },
    { text: "❌ Отклонить", callback_data: `reject:${id}` },
  ]] };
}

function tagMarkup(id) {
  return {
    inline_keyboard: TAGS.map((tag, index) => [{
      text: tag,
      callback_data: `tag:${id}:${index}`,
    }]),
  };
}

function readyMarkup(id, hasComment = false) {
  return { inline_keyboard: [[
    { text: hasComment ? "✏️ Изменить комментарий" : "💬 Комментарий", callback_data: `comment:${id}` },
    { text: "✅ Опубликовать", callback_data: `post:${id}` },
  ], [
    { text: "◀️ Выбрать другой тег", callback_data: `approve:${id}` },
    { text: "❌ Отклонить", callback_data: `reject:${id}` },
  ]] };
}

function commentMarkup(id) {
  return { inline_keyboard: [[
    { text: "Отмена", callback_data: `cancel_comment:${id}` },
  ]] };
}

function moderationText(record, id) {
  const lines = [`📩 Предложка #${id}`];
  if (record.tag) lines.push(`Тег: ${record.tag}`);
  if (record.comment) lines.push(`Комментарий сохранён: ${record.comment}`);
  return lines.join("\n");
}

function publicText(record) {
  const parts = [record.tag, record.sourceText, record.comment ? `${MODERATOR_SIGNATURE}\n${record.comment}` : ""];
  return parts.filter(Boolean).join("\n\n").trim();
}

function publicCaption(record) {
  const original = record.sourceCaption || "";
  return [record.tag, original, record.comment ? `${MODERATOR_SIGNATURE}\n${record.comment}` : ""]
    .filter(Boolean).join("\n\n").slice(0, 1024);
}

function originalContent(message) {
  if (typeof message.text === "string") {
    return { sourceKind: "text", sourceText: message.text };
  }
  return {
    sourceKind: "media",
    sourceCaption: message.caption || "",
  };
}

async function publishSubmission(record, env) {
  const sourceMessageIds = record.sourceMessageIds || [record.sourceMessageId];
  if (record.sourceKind === "text") {
    return telegram(env, "sendMessage", {
      chat_id: env.PUBLIC_CHANNEL_ID,
      text: publicText(record).slice(0, 4096),
    });
  }

  if (sourceMessageIds.length === 1) {
    return telegram(env, "copyMessage", {
      chat_id: env.PUBLIC_CHANNEL_ID,
      from_chat_id: record.sourceChatId,
      message_id: sourceMessageIds[0],
      caption: publicCaption(record),
    });
  }

  const copied = await telegram(env, "copyMessages", {
    chat_id: env.PUBLIC_CHANNEL_ID,
    from_chat_id: record.sourceChatId,
    message_ids: sourceMessageIds,
  });
  if (copied.length && publicCaption(record)) {
    await telegram(env, "editMessageCaption", {
      chat_id: env.PUBLIC_CHANNEL_ID,
      message_id: copied[0].message_id,
      caption: publicCaption(record),
    });
  }
  return copied;
}

async function answer(env, chatId, text) {
  return telegram(env, "sendMessage", { chat_id: chatId, text });
}

async function moderationChatId(env) {
  return await env.SUGGESTIONS.get("config:moderation_chat_id") || env.MODERATION_CHAT_ID;
}

async function rememberMigratedChat(error, env) {
  const migratedId = error?.telegramParameters?.migrate_to_chat_id;
  if (!migratedId) return null;
  await env.SUGGESTIONS.put("config:moderation_chat_id", String(migratedId));
  console.log("moderation chat migrated", String(migratedId));
  return String(migratedId);
}

async function copySubmission(message, env, messageIds) {
  let targetChatId = await moderationChatId(env);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (messageIds.length === 1) {
        const copied = await telegram(env, "copyMessage", {
          chat_id: targetChatId,
          from_chat_id: message.chat.id,
          message_id: messageIds[0],
        });
        return { chatId: targetChatId, messageIds: [copied.message_id] };
      }
      const copied = await telegram(env, "copyMessages", {
        chat_id: targetChatId,
        from_chat_id: message.chat.id,
        message_ids: messageIds,
      });
      return { chatId: targetChatId, messageIds: copied.map((item) => item.message_id) };
    } catch (error) {
      const migratedId = await rememberMigratedChat(error, env);
      if (!migratedId) throw error;
      targetChatId = migratedId;
    }
  }
  throw new Error("Could not resolve moderation chat migration");
}

async function createPendingSubmission(message, env, messageIds) {
  const id = submissionId();
  const copied = await copySubmission(message, env, messageIds);
  const record = {
    sourceChatId: copied.chatId,
    sourceMessageIds: copied.messageIds,
    ...originalContent(message),
  };
  const control = await telegram(env, "sendMessage", {
    chat_id: copied.chatId,
    text: `📩 Предложка #${id}\nВыберите действие:`,
    reply_to_message_id: copied.messageIds[0],
    reply_markup: initialModerationMarkup(id),
  });
  record.controlMessageId = control.message_id;
  await env.SUGGESTIONS.put(`pending:${id}`, JSON.stringify(record));
  for (const messageId of copied.messageIds) {
    await env.SUGGESTIONS.put(`moderation:${copied.chatId}:${messageId}`, id, { expirationTtl: 604800 });
  }
}

async function finishSubmission(message, env, messageIds) {
  let accepted = false;
  try {
    await createPendingSubmission(message, env, messageIds);
    accepted = true;
  } catch (error) {
    console.error("submission failed", error);
    try {
      await answer(env, message.chat.id, "Не удалось принять это сообщение. Попробуйте ещё раз.");
    } catch (replyError) {
      console.error("failure reply failed", replyError);
    }
    return;
  }

  try {
    await env.SUGGESTIONS.put(`cooldown:${message.from?.id || message.chat.id}`, "1", {
      expirationTtl: COOLDOWN_SECONDS,
    });
  } catch (error) {
    // The moderation record already exists. Do not tell the sender that the
    // submission failed just because the anti-spam marker could not be saved.
    console.error("cooldown save failed; submission was accepted", error);
  }

  // A successful submission must not be reported as failed if only this reply fails.
  if (accepted) try {
    await answer(env, message.chat.id, "Принято. Спасибо! Публикация возможна после проверки администрацией.");
  } catch (error) {
    console.error("success reply failed; submission was accepted", error);
  }
}

async function receiveMessage(message, env) {
  if (message.chat?.type !== "private") return;
  const userId = String(message.from?.id || message.chat.id);
  const cooldownKey = `cooldown:${userId}`;
  try {
    if (await env.SUGGESTIONS.get(cooldownKey)) {
      await answer(env, message.chat.id, "Подожди перед следующей предложкой.");
      return;
    }
  } catch (error) {
    // A temporary KV read failure must not discard the user's message.
    console.error("cooldown lookup failed; continuing", error);
  }

  const mediaGroupId = message.media_group_id;
  if (!mediaGroupId) {
    await finishSubmission(message, env, [message.message_id]);
    return;
  }

  const groupKey = `album:${userId}:${mediaGroupId}`;
  // Albums arrive as parallel webhook requests. Durable Objects serialize
  // their writes, which avoids the KV race that could lose album items.
  const stub = env.ALBUMS.get(env.ALBUMS.idFromName(groupKey));
  await stub.fetch("https://album/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
}

async function callbackQuery(callback, env) {
  const userId = callback.from?.id;
  const message = callback.message;
  const data = callback.data || "";
  const match = /^(approve|tag|comment|cancel_comment|post|reject):([A-Z0-9]{8})(?::(\d+))?$/.exec(data);
  if (!message || !userId || !match) return;
  if (!await isModerator(userId, env)) {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "У вас нет прав модератора", show_alert: true });
    return;
  }
  const [, action, id, tagIndex] = match;
  const record = await env.SUGGESTIONS.get(`pending:${id}`, "json");
  if (!record) {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Эта предложка уже обработана или устарела", show_alert: true });
    return;
  }
  try {
    if (action === "reject") {
      await env.SUGGESTIONS.delete(`pending:${id}`);
      await telegram(env, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: `❌ Отклонено • предложка #${id}`,
      });
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Отклонено" });
      return;
    }

    if (action === "approve") {
      await telegram(env, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: moderationText(record, id) + "\n\nВыберите тег:",
        reply_markup: tagMarkup(id),
      });
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Выберите тег" });
      return;
    }

    if (action === "tag") {
      const tag = TAGS[Number(tagIndex)];
      if (!tag) throw new Error("Unknown tag");
      record.tag = tag;
      await env.SUGGESTIONS.put(`pending:${id}`, JSON.stringify(record));
      await telegram(env, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: moderationText(record, id) + "\n\nДобавить комментарий или публиковать?",
        reply_markup: readyMarkup(id, Boolean(record.comment)),
      });
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: tag });
      return;
    }

    if (action === "comment") {
      record.comment_mode_user_id = userId;
      await env.SUGGESTIONS.put(`pending:${id}`, JSON.stringify(record));
      await telegram(env, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: `${moderationText(record, id)}\n\nОтветьте текстом на скопированное сообщение предложки.\nКомментарий будет добавлен в самый низ поста.`,
        reply_markup: commentMarkup(id),
      });
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Жду комментарий ответом" });
      return;
    }

    if (action === "cancel_comment") {
      delete record.comment_mode_user_id;
      await env.SUGGESTIONS.put(`pending:${id}`, JSON.stringify(record));
      await telegram(env, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: moderationText(record, id) + "\n\nДобавить комментарий или публиковать?",
        reply_markup: readyMarkup(id, Boolean(record.comment)),
      });
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Отменено" });
      return;
    }

    if (action === "post") {
      if (!record.tag) {
        await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Сначала выберите тег", show_alert: true });
        return;
      }
      await publishSubmission(record, env);
      await env.SUGGESTIONS.delete(`pending:${id}`);
      await telegram(env, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: `✅ Опубликовано • предложка #${id}`,
      });
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Опубликовано" });
      return;
    }
  } catch (error) {
    console.error("moderation failed", error);
    try { await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Не удалось выполнить действие", show_alert: true }); } catch (replyError) { console.error(replyError); }
  }
}

async function receiveModeratorComment(message, env) {
  if (message.chat?.type !== "supergroup" && message.chat?.type !== "group") return false;
  const reply = message.reply_to_message;
  if (!reply || typeof message.text !== "string") return false;
  const id = await env.SUGGESTIONS.get(`moderation:${message.chat.id}:${reply.message_id}`);
  if (!id) return false;
  const record = await env.SUGGESTIONS.get(`pending:${id}`, "json");
  if (!record || !record.comment_mode_user_id || String(record.comment_mode_user_id) !== String(message.from?.id)) return false;
  const comment = message.text.trim();
  if (!comment || comment.length > MAX_COMMENT_LENGTH) {
    await answer(env, message.chat.id, `Комментарий должен быть от 1 до ${MAX_COMMENT_LENGTH} символов.`);
    return true;
  }
  record.comment = comment;
  delete record.comment_mode_user_id;
  await env.SUGGESTIONS.put(`pending:${id}`, JSON.stringify(record));
  if (record.controlMessageId) {
    await telegram(env, "editMessageText", {
      chat_id: message.chat.id,
      message_id: record.controlMessageId,
      text: moderationText(record, id) + "\n\nКомментарий добавлен. Можно публиковать.",
      reply_markup: readyMarkup(id, true),
    });
  }
  await answer(env, message.chat.id, "Комментарий сохранён. Теперь нажмите «Опубликовать».");
  return true;
}

async function handleUpdate(update, env) {
  if (update.callback_query) return callbackQuery(update.callback_query, env);
  if (update.message) {
    if (await receiveModeratorComment(update.message, env)) return;
    if (update.message.chat?.type === "private" && /^\/start(?:@\w+)?(?:\s|$)/.test(update.message.text || "")) {
      return answer(env, update.message.chat.id, "Привет! Напиши предложение или отправь медиафайл/стикер. Сообщение попадёт администраторам анонимно.");
    }
    return receiveMessage(update.message, env);
  }
}

async function setupWebhook(request, env, url) {
  const setupSecret = request.headers.get("X-Setup-Secret");
  if (!setupSecret || setupSecret !== env.WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);

  const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
  try {
    const result = await telegram(env, "setWebhook", {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      drop_pending_updates: true,
    });
    return json({ ok: true, worker_url: url.origin, telegram: result });
  } catch (error) {
    console.error("webhook setup failed", error);
    return json({ error: "Telegram webhook setup failed" }, 502);
  }
}

async function diagnostics(request, env, url) {
  const setupSecret = request.headers.get("X-Setup-Secret");
  if (!setupSecret || setupSecret !== env.WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
  try {
    const me = await telegram(env, "getMe", {});
    const webhook = await telegram(env, "getWebhookInfo", {});
    return json({
      ok: true,
      worker_url: url.origin,
      bot: { id: me.id, username: me.username },
      webhook: {
        url: webhook.url,
        pending_update_count: webhook.pending_update_count,
        last_error_message: webhook.last_error_message || null,
        last_error_date: webhook.last_error_date || null,
      },
    });
  } catch (error) {
    console.error("diagnostics failed", error);
    return json({ error: "Telegram API call failed from Worker" }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const missing = configError(env);
    if (missing) return json({ error: `Missing configuration: ${missing}` }, 500);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/admin/set-webhook") {
      return setupWebhook(request, env, url);
    }
    if (request.method === "GET" && url.pathname === "/admin/diagnostics") {
      return diagnostics(request, env, url);
    }
    const expectedPath = `/webhook/${env.WEBHOOK_SECRET}`;
    const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (request.method !== "POST" || (url.pathname !== expectedPath && headerSecret !== env.WEBHOOK_SECRET)) return json({ error: "Not found" }, 404);
    let update;
    try { update = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    // A webhook must be acknowledged quickly. Telegram retries updates when
    // copying media or sending replies takes longer than its HTTP timeout.
    ctx.waitUntil(handleUpdate(update, env).catch((error) => console.error("update failed", error)));
    return json({ ok: true });
  },
};

export class AlbumCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const message = await request.json();
    const messages = await this.state.storage.get("messages") || [];
    if (!messages.some((item) => item.message_id === message.message_id)) {
      messages.push(message);
    }
    await this.state.storage.put("messages", messages);
    await this.state.storage.setAlarm(Date.now() + ALBUM_WAIT_MS);
    return json({ ok: true });
  }

  async alarm() {
    const messages = await this.state.storage.get("messages") || [];
    if (!messages.length) return;
    await this.state.storage.delete("messages");
    messages.sort((a, b) => a.message_id - b.message_id);
    await finishSubmission(messages[0], this.env, messages.map((item) => item.message_id));
  }
}
