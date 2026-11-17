import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const API_ROOT = 'https://api.telegram.org';
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
const DRAFT_INTERVAL = 1_000;
const MAX_ACTIONS = 512;
const ACTION_TTL = 30 * 60_000;
const MEDIA = [
  ['photo', 'image', 'image/jpeg'],
  ['voice', 'audio', 'audio/ogg'],
  ['audio', 'audio', 'audio/mpeg'],
  ['animation', 'video', 'video/mp4'],
  ['video', 'video', 'video/mp4'],
  ['video_note', 'video', 'video/mp4'],
  ['document', 'file', 'application/octet-stream'],
];

class TelegramError extends Error {
  constructor(code, kind, retryAfterMs = 0) {
    super(code);
    this.code = code;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

class AdmissionDeferred extends Error {}

function telegramError(status, retryAfter) {
  if (status === 401 || status === 403) return new TelegramError('INVALID_TOKEN', 'auth');
  if (status === 409) return new TelegramError('RECEIVER_CONFLICT', 'rejected');
  if (status === 429) {
    const retryAfterMs = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 300) * 1_000 : 1_000;
    return new TelegramError('RATE_LIMITED', 'retry', retryAfterMs);
  }
  return new TelegramError('TELEGRAM_API_ERROR', status >= 400 && status < 500 ? 'rejected' : undefined);
}

function validId(id) {
  return Number.isSafeInteger(id) && id > 0;
}

function splitText(text) {
  const parts = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(position + MAX_MESSAGE_LENGTH, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(position, end));
    position = end;
  }
  return parts;
}

function mentionsBot(message, bot) {
  if (message.reply_to_message?.from?.id === bot.id) return true;
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const username = bot.username?.toLowerCase();
  if (entities.some((entity) => (
    (entity.type === 'text_mention' && entity.user?.id === bot.id)
    || (username && ['mention', 'bot_command'].includes(entity.type)
      && text.slice(entity.offset, entity.offset + entity.length).toLowerCase().split('@')[1] === username)
  ))) return true;
  return !!username && [...text.matchAll(/@([a-z\d_]+)/gi)]
    .some(([, handle]) => handle.toLowerCase() === username);
}

function mediaOf(message) {
  for (const [key, kind, mediaType] of MEDIA) {
    const media = key === 'photo' ? message.photo?.at(-1) : message[key];
    if (typeof media?.file_id === 'string' && media.file_id) return { media, kind, mediaType };
  }
  return null;
}

function replyRoute(message, proactive = false) {
  if (typeof message?.chatId !== 'string' || !/^-?[1-9]\d{0,15}$/.test(message.chatId)
    || !Number.isSafeInteger(Number(message.chatId))) {
    throw new TelegramError('INVALID_REPLY', 'rejected');
  }
  const route = { chat_id: message.chatId };
  if (validId(Number(message.threadId))) route.message_thread_id = Number(message.threadId);
  if (!proactive && validId(Number(message.replyTo))) {
    route.reply_parameters = { message_id: Number(message.replyTo), allow_sending_without_reply: true };
  }
  return route;
}

function outboundMedia(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > 8) throw new TelegramError('INVALID_REPLY', 'rejected');
  let remaining = MAX_ATTACHMENT_BYTES;
  return attachments.map(file => {
    const { name, mime, data } = file ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(name)
      || typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mime) || typeof data !== 'string'
      || data.length > Math.ceil(remaining / 3) * 4) throw new TelegramError('INVALID_REPLY', 'rejected');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > remaining || bytes.toString('base64') !== data) {
      throw new TelegramError('INVALID_REPLY', 'rejected');
    }
    remaining -= bytes.length;
    const type = mime.toLowerCase();
    const method = ['image/jpeg', 'image/png'].includes(type) ? 'Photo'
      : type === 'audio/ogg' ? 'Voice'
        : ['audio/mpeg', 'audio/mp4'].includes(type) ? 'Audio'
          : type === 'video/mp4' ? 'Video' : 'Document';
    return { method, file: new Blob([bytes], { type }), name };
  });
}

async function readBounded(response) {
  if (!response.body) throw new TelegramError('ATTACHMENT_UNAVAILABLE');
  if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) {
    await response.body.cancel();
    throw new TelegramError('ATTACHMENT_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new TelegramError('ATTACHMENT_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export const telegram = {
  id: 'telegram',

  create(config, { onMessage, setStatus, signal, allowSender = () => false, fetch = globalThis.fetch }) {
    const { token, groupPolicy = 'mention', replyToMessage = false } = config;
    const botPath = `/bot${token}`;
    const drafts = new Map();
    const actions = new Map();

    async function api(method, data, timeoutMs = 15_000) {
      let response;
      let result;
      try {
        const multipart = data instanceof FormData;
        response = await fetch(API_ROOT + botPath + '/' + method, {
          method: 'POST',
          ...(multipart ? { body: data } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          redirect: 'error',
        });
        result = await response.json();
      } catch {
        if (response && !response.ok) throw telegramError(response.status);
        throw new TelegramError('TELEGRAM_NETWORK_ERROR');
      }
      if (!response.ok || result?.ok !== true) {
        const status = response.ok ? result?.error_code : response.status;
        // A forbidden send may be specific to the destination (bot blocked/removed).
        if (['sendMessage', 'sendMessageDraft', 'sendDocument', 'sendPhoto', 'sendVoice', 'sendAudio', 'sendVideo',
          'sendChatAction', 'editMessageText'].includes(method) && status === 403) {
          throw new TelegramError('DESTINATION_FORBIDDEN', 'rejected');
        }
        if (method === 'editMessageText' && status === 400 && typeof result?.description === 'string') {
          if (/message is not modified/i.test(result.description)) return true;
          if (/message to edit not found|message can.t be edited/i.test(result.description)) {
            throw new TelegramError('EDIT_UNAVAILABLE', 'rejected');
          }
        }
        throw telegramError(status, result?.parameters?.retry_after);
      }
      return result.result;
    }

    async function submit(message) {
      try { return await onMessage(message); }
      catch { throw new AdmissionDeferred(); }
    }

    async function receiveAction(update, bot) {
      const query = update.callback_query;
      const message = query?.message;
      const action = actions.get(query?.data);
      if (!action || action.expiresAt < Date.now() || typeof query.id !== 'string' || !validId(query.from?.id)
        || query.from.is_bot || !allowSender(action.senderId) || action.senderId !== String(query.from.id)
        || message?.from?.id !== bot.id || String(message.chat?.id) !== action.chatId
        || message.message_id !== action.messageId || (message.message_thread_id === undefined
          ? undefined : String(message.message_thread_id)) !== action.threadId) return;
      const inbound = { id: String(update.update_id), senderId: action.senderId, chatId: action.chatId, text: action.text,
        requireExistingSession: true };
      if (action.threadId) inbound.threadId = action.threadId;
      if (replyToMessage) inbound.replyTo = String(action.messageId);
      await submit(inbound);
      actions.delete(query.data);
      await api('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    }

    async function download({ media, kind, mediaType: fallbackType }) {
      if (media.file_size > MAX_ATTACHMENT_BYTES) throw new TelegramError('ATTACHMENT_TOO_LARGE');
      const file = await api('getFile', { file_id: media.file_id });
      if (file?.file_size > MAX_ATTACHMENT_BYTES) throw new TelegramError('ATTACHMENT_TOO_LARGE');
      const parts = typeof file?.file_path === 'string' ? file.file_path.split('/') : [];
      if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
        throw new TelegramError('ATTACHMENT_UNAVAILABLE');
      }
      const response = await fetch(API_ROOT + '/file' + botPath + '/' + parts.map(encodeURIComponent).join('/'), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
      });
      if (!response.ok) throw new TelegramError('ATTACHMENT_UNAVAILABLE');
      const data = await readBounded(response);
      const name = (media.file_name || parts.at(-1)).split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
      const declared = [media.mime_type, response.headers.get('content-type')]
        .find((value) => typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value) && value !== 'application/octet-stream');
      return { name: name || 'attachment', kind, mediaType: declared ?? fallbackType, data: data.toString('base64') };
    }

    async function receive(update, bot) {
      if (update.callback_query) return receiveAction(update, bot);
      const message = update.message;
      if (!validId(message?.message_id) || !validId(message.from?.id) || message.from.is_bot || message.sender_chat
        || !Number.isSafeInteger(message.chat?.id)) return;
      const senderId = String(message.from.id);
      if (!allowSender(senderId)) return;
      if (message.chat.type !== 'private' && groupPolicy !== 'open' && !mentionsBot(message, bot)) return;

      let caption = message.text || message.caption;
      const command = typeof caption === 'string' && caption.match(/^(\/[a-z\d_]{1,32})@([a-z\d_]{1,32})(?=\s|$)/i);
      if (command) {
        if (command[2].toLowerCase() !== bot.username?.toLowerCase()) return;
        caption = command[1] + caption.slice(command[0].length);
      }
      const content = [caption];
      if (Number.isFinite(message.location?.latitude) && Number.isFinite(message.location.longitude)) {
        content.push(`[location: ${message.location.latitude}, ${message.location.longitude}]`);
      }
      const attachments = [];
      const descriptor = mediaOf(message);
      if (descriptor) {
        try { attachments.push(await download(descriptor)); }
        catch (error) {
          if (signal.aborted) return;
          content.push(error.code === 'ATTACHMENT_TOO_LARGE' ? '[Telegram attachment exceeds 1 MiB]' : '[Telegram attachment unavailable]');
        }
      }
      const text = content.filter(Boolean).join('\n');
      if (signal.aborted || (!text && !attachments.length)) return;
      const inbound = { id: String(update.update_id), senderId, chatId: String(message.chat.id), text, attachments };
      if (validId(message.message_thread_id)) inbound.threadId = String(message.message_thread_id);
      if (replyToMessage) inbound.replyTo = String(message.message_id);
      await submit(inbound);
    }

    function buttonsFor(message, buttons) {
      if (!message.senderId || !Array.isArray(buttons)) return [];
      return buttons.slice(0, 4).filter(Array.isArray).map(row => row.slice(0, 4)
        .filter(text => typeof text === 'string' && /^[^\u0000-\u001f\u007f]{1,64}$/.test(text)
          && text.trim() && Buffer.byteLength(text) <= 64)
        .map(text => ({ text, callback_data: `dsh:${randomBytes(18).toString('base64url')}` })))
        .filter(row => row.length > 0);
    }

    function rememberActions(buttons, message, messageId, allowCommands) {
      if (!validId(messageId)) return;
      for (const { text, callback_data: data } of buttons.flat()) {
        actions.set(data, {
          text: !allowCommands && text.trimStart().startsWith('/') ? `已选择「${text.trim()}」` : text,
          messageId, chatId: message.chatId, threadId: message.threadId, senderId: message.senderId,
          expiresAt: Date.now() + ACTION_TTL,
        });
        if (actions.size > MAX_ACTIONS) actions.delete(actions.keys().next().value);
      }
    }

    return {
      async run() {
        if (signal.aborted) return;
        setStatus('connecting');
        if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
          setStatus('auth-required', 'INVALID_TOKEN');
          return;
        }
        let offset;
        let bot;
        let connected = false;
        let delay = 250;
        while (!signal.aborted) {
          try {
            if (!bot) {
              bot = await api('getMe', {});
              if (!validId(bot?.id) || bot.is_bot !== true) {
                setStatus('auth-required', 'INVALID_TOKEN');
                return;
              }
            }
            const timeout = connected ? 25 : 0;
            const updates = await api('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, 35_000);
            if (signal.aborted) return;
            if (!Array.isArray(updates)) throw new TelegramError('TELEGRAM_API_ERROR');
            if (!connected) setStatus('connected');
            connected = true;
            for (const update of updates) {
              if (signal.aborted) return;
              if (!validId(update?.update_id) || (offset !== undefined && update.update_id < offset)) continue;
              await receive(update, bot);
              offset = update.update_id + 1;
            }
            delay = 250;
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof TelegramError && error.kind === 'auth') {
              setStatus('auth-required', error.code);
              return;
            }
            // Keep the broker running while its inbox drains. Telegram has not
            // acknowledged this update and will return it at the same offset.
            if (!(error instanceof AdmissionDeferred)) {
              connected = false;
              setStatus('error', error instanceof TelegramError ? error.code : 'INBOUND_UNAVAILABLE');
            }
            try { await sleep(Math.max(delay, error instanceof TelegramError ? error.retryAfterMs : 0), undefined, { signal }); }
            catch (abortError) { if (signal.aborted) return; throw abortError; }
            delay = Math.min(delay * 2, 15_000);
          }
        }
      },

      async send(message, text, payload = {}) {
        const proactive = payload.metadata?.proactive === true;
        const route = replyRoute(message, proactive);
        if (message.senderId !== undefined && !allowSender(message.senderId)) {
          throw new TelegramError('ACCESS_DENIED', 'rejected');
        }
        const media = outboundMedia(payload.attachments);
        const parts = typeof text === 'string' ? splitText(text) : [];
        if (!parts.length && !media.length) throw new TelegramError('INVALID_REPLY', 'rejected');
        const offerCommands = payload.metadata?.buttons === undefined && message.text === '/help' && !proactive;
        const buttons = buttonsFor(message, offerCommands ? [['/new', '/stop', '/compact']] : payload.metadata?.buttons);
        const draft = drafts.get(payload.messageId);
        let submitted = false;
        try {
          for (const [index, part] of parts.entries()) {
            const markup = buttons.length && index === parts.length - 1 ? { reply_markup: { inline_keyboard: buttons } } : {};
            let sent;
            if (index === 0 && draft?.groupId && draft.senderId === message.senderId
              && draft.chatId === message.chatId && draft.threadId === message.threadId) {
              try {
                if (draft.published !== part || markup.reply_markup) {
                  await api('editMessageText', { chat_id: route.chat_id, message_id: draft.groupId, text: part, ...markup });
                }
                sent = { message_id: draft.groupId };
              } catch (error) {
                if (error.code !== 'EDIT_UNAVAILABLE') throw error;
              }
            }
            sent ??= await api('sendMessage', { ...route, text: part, ...markup });
            submitted = true;
            if (markup.reply_markup) rememberActions(buttons, message, sent?.message_id, offerCommands);
          }
          for (const { method, file, name } of media) {
            const form = new FormData();
            for (const [field, value] of Object.entries(route)) {
              form.set(field, typeof value === 'object' ? JSON.stringify(value) : String(value));
            }
            form.set(method.toLowerCase(), file, name);
            await api('send' + method, form);
            submitted = true;
          }
        } catch (error) {
          if (submitted) throw new TelegramError('PARTIAL_DELIVERY');
          throw error;
        }
        drafts.delete(payload.messageId);
      },

      async sendUpdate({ type, messageId, text, message }) {
        if (!message || !allowSender(message.senderId)) throw new TelegramError('ACCESS_DENIED', 'rejected');
        const route = replyRoute(message);
        if (type === 'reasoning') return;
        if (type === 'progress') {
          const { reply_parameters, ...target } = route;
          await api('sendChatAction', { ...target, action: 'typing' });
          return;
        }
        if (type === 'tool') {
          await api('sendMessage', { ...route, text: '🔧 ' + String(text).slice(0, 120) });
          return;
        }
        if (type !== 'delta' || typeof text !== 'string' || !text || typeof messageId !== 'string') {
          throw new TelegramError('INVALID_REPLY', 'rejected');
        }
        let draft = drafts.get(messageId);
        if (!draft) {
          const hash = createHash('sha256').update(messageId).digest().readUInt32BE();
          draft = { senderId: message.senderId, chatId: message.chatId, threadId: message.threadId,
            id: (hash & 0x7fffffff) || 1, text: '', published: '', edited: 0, groupId: null };
          drafts.set(messageId, draft);
          if (drafts.size > 128) drafts.delete(drafts.keys().next().value);
        } else if (draft.senderId !== message.senderId || draft.chatId !== message.chatId || draft.threadId !== message.threadId) {
          throw new TelegramError('ACCESS_DENIED', 'rejected');
        }
        draft.text = (draft.text + text).slice(0, MAX_MESSAGE_LENGTH + 1);
        const preview = splitText(draft.text)[0];
        const now = Date.now();
        if (preview === draft.published || now - draft.edited < DRAFT_INTERVAL) return;
        if (route.chat_id.startsWith('-')) {
          if (draft.groupId) {
            await api('editMessageText', { chat_id: route.chat_id, message_id: draft.groupId, text: preview });
          } else {
            const sent = await api('sendMessage', { ...route, text: preview });
            if (!validId(sent?.message_id)) throw new TelegramError('TELEGRAM_API_ERROR');
            draft.groupId = sent.message_id;
          }
        } else {
          const { reply_parameters, ...target } = route;
          await api('sendMessageDraft', { ...target, chat_id: Number(route.chat_id), draft_id: draft.id, text: preview });
        }
        draft.published = preview;
        draft.edited = now;
      },
    };
  },
};
