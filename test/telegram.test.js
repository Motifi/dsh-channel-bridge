import test from 'node:test';
import assert from 'node:assert/strict';
import { telegram } from '../lib/channels/telegram.js';

const token = '123:fake_bot_token';

function response(result, status = 200) {
  return Response.json({ ok: status === 200, result }, { status });
}

function message(id, senderId, text, extra = {}) {
  return {
    update_id: id,
    message: {
      message_id: id + 100,
      from: { id: senderId },
      chat: { id: -123, type: 'supergroup', is_forum: true },
      text,
      ...extra,
    },
  };
}

test('Telegram polling authenticates, filters sender and mention, and acknowledges a durable topic message', async () => {
  const status = [];
  const incoming = [];
  const offsets = [];
  const abort = new AbortController();
  const adapter = telegram.create({ token, replyToMessage: true }, {
    signal: abort.signal,
    setStatus: (...entry) => status.push(entry),
    allowSender: (id) => id === '42',
    onMessage: async (entry) => { incoming.push(entry); },
    fetch: async (url, options) => {
      switch (new URL(url).pathname.split('/').pop()) {
        case 'getMe': return response({ id: 123, is_bot: true, username: 'ExampleBot' });
        case 'getUpdates': {
          offsets.push(JSON.parse(options.body).offset);
          if (offsets.length === 2) {
            abort.abort();
            return response([]);
          }
          return response([
            message(1, 99, '@ExampleBot ignore', { document: { file_id: 'untrusted' } }),
            message(2, 42, '@ExampleBotOther ignore'),
            message(3, 42, '@ExampleBot hello', { message_thread_id: 22, is_topic_message: true }),
          ]);
        }
        default: assert.fail('Unexpected Telegram API method');
      }
    },
  });
  await adapter.run();
  assert.deepEqual(offsets, [undefined, 4]);
  assert.deepEqual(status, [['connecting'], ['connected']]);
  assert.deepEqual(incoming.map(({ id, senderId, chatId, threadId, replyTo, text }) =>
    ({ id, senderId, chatId, threadId, replyTo, text })), [{
    id: '3', senderId: '42', chatId: '-123', threadId: '22', replyTo: '103', text: '@ExampleBot hello',
  }]);
});

test('Telegram retries a transient admission failure before confirming the update', async () => {
  const abort = new AbortController();
  const offsets = [];
  const status = [];
  let attempts = 0;
  const adapter = telegram.create({ token, groupPolicy: 'open' }, {
    signal: abort.signal,
    setStatus: (...entry) => status.push(entry),
    allowSender: () => true,
    onMessage: async () => {
      if (++attempts === 1) throw new Error('outbox full');
    },
    fetch: async (url, { body }) => {
      if (String(url).endsWith('/getMe')) return response({ id: 123, is_bot: true });
      offsets.push(JSON.parse(body).offset);
      if (offsets.length === 3) abort.abort();
      return response([message(5, 42, 'hello')]);
    },
  });
  await adapter.run();
  assert.deepEqual(offsets, [undefined, undefined, 6]);
  assert.deepEqual(status, [['connecting'], ['connected']]);
  assert.equal(attempts, 2);
});

test('Telegram bounds attachment downloads before submitting to the DSH broker', async () => {
  const abort = new AbortController();
  let incoming;
  const adapter = telegram.create({ token, groupPolicy: 'open' }, {
    signal: abort.signal,
    setStatus: () => {},
    allowSender: () => true,
    onMessage: async (entry) => { incoming = entry; abort.abort(); },
    fetch: async (url) => {
      if (String(url).endsWith('/getMe')) return response({ id: 123, is_bot: true });
      if (String(url).endsWith('/getUpdates')) return response([message(5, 42, 'large file', {
        document: { file_id: 'large123', file_size: 1024 * 1024 + 1 },
      })]);
      assert.fail('Telegram must not request an attachment above the broker cap');
    },
  });
  await adapter.run();
  assert.deepEqual(incoming.attachments, []);
  assert.equal(incoming.text, 'large file\n[Telegram attachment exceeds 1 MiB]');
});

test('Telegram ingests bounded attachments and preserves exact topic and reply routing on send', async () => {
  const abort = new AbortController();
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const sent = [];
  let received;
  const adapter = telegram.create({ token, replyToMessage: true, groupPolicy: 'open' }, {
    signal: abort.signal,
    setStatus: () => {},
    allowSender: () => true,
    onMessage: async (entry) => {
      received = entry;
      await adapter.send(entry, '🌟'.repeat(2049));
      abort.abort();
    },
    fetch: async (url, { body, redirect }) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/getMe')) return response({ id: 123, is_bot: true });
      if (path.endsWith('/getUpdates')) {
        return response([message(9, 42, undefined, {
          photo: [{ file_id: 'smaller' }, { file_id: 'photo123' }],
          message_thread_id: 52,
          is_topic_message: true,
        })]);
      }
      if (path.endsWith('/getFile')) {
        assert.deepEqual(JSON.parse(body), { file_id: 'photo123' });
        return response({ file_path: 'photos/file.png', file_size: data.length });
      }
      if (path.endsWith('/photos/file.png')) {
        assert.equal(redirect, 'error');
        return new Response(data, { headers: { 'content-type': 'image/png' } });
      }
      if (path.endsWith('/sendMessage')) {
        sent.push(JSON.parse(body));
        return response({ message_id: 1001 });
      }
      assert.fail('Unexpected Telegram API method');
    },
  });
  await adapter.run();
  assert.deepEqual(received.attachments, [{ name: 'file.png', kind: 'image', mediaType: 'image/png', data: data.toString('base64') }]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {
    chat_id: '-123', message_thread_id: 52,
    reply_parameters: { message_id: 109, allow_sending_without_reply: true },
    text: '🌟'.repeat(2048),
  });
  assert.equal(sent[1].text, '🌟');
});

test('Telegram exposes auth and uncertain-send outcomes without exposing the secret token', async () => {
  const statuses = [];
  const abort = new AbortController();
  const adapter = telegram.create({ token }, {
    signal: abort.signal,
    setStatus: (...entry) => statuses.push(entry),
    allowSender: () => false,
    onMessage: assert.fail,
    fetch: async (url) => {
      if (String(url).endsWith('/getMe')) return response(null, 401);
      throw new Error(`network contains ${url}`);
    },
  });
  await adapter.run();
  assert.deepEqual(statuses, [['connecting'], ['auth-required', 'INVALID_TOKEN']]);
  await assert.rejects(adapter.send({ chatId: '42' }, 'reply'), (error) => (
    !error.message.includes(token) && !error.kind
  ));
});

test('Telegram keeps bot-addressed commands and inline actions in the approved sender topic', async t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const received = [];
  const answered = [];
  const subscriptions = [];
  let callbackData;
  let polls = 0;
  const adapter = telegram.create({ token, replyToMessage: true }, {
    signal: abort.signal,
    setStatus() {},
    allowSender: id => id === '42',
    async onMessage(entry) {
      received.push(entry);
      if (entry.text === '/help') await adapter.send(entry, 'Controls');
      return true;
    },
    async fetch(url, { body }) {
      switch (new URL(url).pathname.split('/').pop()) {
        case 'getMe': return response({ id: 123, is_bot: true, username: 'ExampleBot' });
        case 'getUpdates':
          subscriptions.push(JSON.parse(body).allowed_updates);
          if (++polls === 1) return response([
            message(1, 42, '/help@OtherBot'),
            message(2, 42, '/help@examplebot', { message_thread_id: 22 }),
          ]);
          if (polls === 2) return response([[99, 22], [42, 25], [42, 22]].map(([id, topic], index) => ({
            update_id: index + 3,
            callback_query: {
              id: String(id), from: { id }, data: callbackData,
              message: { message_id: 900, message_thread_id: topic, chat: { id: -123 }, from: { id: 123 } },
            },
          })));
          abort.abort();
          return response([]);
        case 'sendMessage':
          callbackData = JSON.parse(body).reply_markup.inline_keyboard.flat()
            .find(button => button.text === '/stop').callback_data;
          return response({ message_id: 900 });
        case 'answerCallbackQuery':
          answered.push(JSON.parse(body).callback_query_id);
          return response(true);
        default: assert.fail('Unexpected Telegram API method');
      }
    },
  });
  await adapter.run();
  assert.ok(subscriptions[0].includes('callback_query'));
  assert.deepEqual(received.map(({ senderId, threadId, text, requireExistingSession }) =>
    ({ senderId, threadId, text, requireExistingSession })), [
    { senderId: '42', threadId: '22', text: '/help', requireExistingSession: undefined },
    { senderId: '42', threadId: '22', text: '/stop', requireExistingSession: true },
  ]);
  assert.deepEqual(answered, ['42']);
});

test('Telegram treats tool button labels that look like commands as ordinary selected input', async t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const received = [];
  const keyboards = [];
  let polls = 0;
  const adapter = telegram.create({ token, groupPolicy: 'open' }, {
    signal: abort.signal,
    setStatus() {},
    allowSender: id => id === '42',
    async onMessage(entry) {
      received.push(entry);
      if (entry.text === 'pick') await adapter.send(entry, 'Choose', { metadata: { buttons: [[' /stop', '继续']] } });
      return true;
    },
    async fetch(url, { body }) {
      switch (new URL(url).pathname.split('/').pop()) {
        case 'getMe': return response({ id: 123, is_bot: true });
        case 'getUpdates':
          if (++polls === 1) return response([message(1, 42, 'pick')]);
          if (polls === 2) return response(keyboards.flat().map((button, index) => ({
            update_id: index + 2,
            callback_query: { id: String(index), from: { id: 42 }, data: button.callback_data,
              message: { message_id: 900, chat: { id: -123 }, from: { id: 123 } } },
          })));
          abort.abort();
          return response([]);
        case 'sendMessage':
          keyboards.push(...JSON.parse(body).reply_markup.inline_keyboard);
          return response({ message_id: 900 });
        case 'answerCallbackQuery': return response(true);
        default: assert.fail('Unexpected Telegram API method');
      }
    },
  });
  await adapter.run();
  assert.deepEqual(keyboards.flat().map(button => button.text), [' /stop', '继续']);
  assert.equal(received[1].text, '已选择「/stop」');
  assert.equal(received[2].text, '继续');
  assert.ok(received.slice(1).every(entry => entry.requireExistingSession));
});

test('Telegram edits a group stream to its canonical final and uploads bytes to the original topic', async () => {
  const abort = new AbortController();
  const sent = [];
  const adapter = telegram.create({ token }, {
    signal: abort.signal,
    allowSender: id => id === '42',
    async fetch(url, { body }) {
      const method = new URL(url).pathname.split('/').pop();
      sent.push([method, body instanceof FormData ? Object.fromEntries(body) : JSON.parse(body)]);
      return response({ message_id: 900 });
    },
  });
  const original = { id: '1', chatId: '-123', senderId: '42', threadId: '22', replyTo: '12' };
  await adapter.sendUpdate({ type: 'delta', text: 'par', messageId: 'reply', message: original });
  await adapter.send(original, 'partial', { messageId: 'reply', attachments: [
    { name: 'note.txt', mime: 'text/plain', data: Buffer.from('attachment').toString('base64') },
  ] });
  assert.deepEqual(sent.map(([method]) => method), ['sendMessage', 'editMessageText', 'sendDocument']);
  assert.deepEqual(sent[1][1], { chat_id: '-123', message_id: 900, text: 'partial' });
  assert.equal(sent[2][1].message_thread_id, '22');
  assert.equal(sent[2][1].document.name, 'note.txt');
  assert.equal(await sent[2][1].document.text(), 'attachment');
});

test('Telegram uses a private native draft and persists exactly one final answer', async () => {
  const requests = [];
  const adapter = telegram.create({ token }, {
    signal: new AbortController().signal,
    allowSender: id => id === '42',
    async fetch(url, { body }) {
      requests.push([new URL(url).pathname.split('/').pop(), JSON.parse(body)]);
      return response({ message_id: 900 });
    },
  });
  const original = { id: '1', chatId: '42', senderId: '42' };
  await adapter.sendUpdate({ type: 'delta', text: 'par', messageId: 'reply', message: original });
  await adapter.send(original, 'partial', { messageId: 'reply' });
  assert.deepEqual(requests.map(([method]) => method), ['sendMessageDraft', 'sendMessage']);
  assert.equal(requests[0][1].chat_id, 42);
  assert.ok(Number.isSafeInteger(requests[0][1].draft_id) && requests[0][1].draft_id > 0);
  assert.equal(requests[0][1].text, 'par');
  assert.deepEqual(requests[1][1], { chat_id: '42', text: 'partial' });
});
