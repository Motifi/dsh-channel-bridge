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
