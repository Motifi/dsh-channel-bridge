import { setTimeout as sleep } from 'node:timers/promises';

const API_ROOT = 'https://api.telegram.org';
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
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

    async function api(method, data, timeoutMs = 15_000) {
      let response;
      let result;
      try {
        response = await fetch(API_ROOT + botPath + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
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
        if (method === 'sendMessage' && status === 403) throw new TelegramError('DESTINATION_FORBIDDEN', 'rejected');
        throw telegramError(status, result?.parameters?.retry_after);
      }
      return result.result;
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
      const message = update.message;
      if (!validId(message?.message_id) || !validId(message.from?.id) || message.from.is_bot || message.sender_chat
        || !Number.isSafeInteger(message.chat?.id)) return;
      const senderId = String(message.from.id);
      if (!allowSender(senderId)) return;
      if (message.chat.type !== 'private' && groupPolicy !== 'open' && !mentionsBot(message, bot)) return;

      const content = [message.text || message.caption];
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
      try { await onMessage(inbound); }
      catch { throw new AdmissionDeferred(); }
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
            const updates = await api('getUpdates', { offset, timeout, allowed_updates: ['message'] }, 35_000);
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

      async send(message, text) {
        const route = { chat_id: message.chatId };
        if (message.threadId) route.message_thread_id = Number(message.threadId);
        if (message.replyTo) {
          route.reply_parameters = { message_id: Number(message.replyTo), allow_sending_without_reply: true };
        }
        let submitted = false;
        for (const part of splitText(text)) {
          try {
            await api('sendMessage', { ...route, text: part });
            submitted = true;
          } catch (error) {
            if (submitted) throw new TelegramError('PARTIAL_DELIVERY');
            throw error;
          }
        }
      },
    };
  },
};
