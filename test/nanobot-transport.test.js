import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { createNanobotTransport } from '../lib/nanobot-transport.js';

const mockWorker = `
const { createInterface } = require('node:readline');
const send = message => console.log(JSON.stringify(message));
createInterface({input:process.stdin}).on('line', line => {
  const value = JSON.parse(line);
  if (value.op === 'start') {
    if (value.config.token !== 'test-credential' || process.env.SECRET_FROM_HOST) process.exit(3);
    send({type:'status', status:'connected'});
    send({type:'message', message:{id:'123', text:'hi', route:{chatId:'chat'}}});
  }
  if (value.op === 'ack' && !value.ok) process.exit(4);
  if (value.op === 'send') {
    const originalRoute = value.messageId === '123' && value.route.chatId === 'chat';
    const payload = value.text === 'hello' && (!value.attachments || (
      value.attachments[0].data === 'cGljdHVyZQ==' && value.metadata.buttons[0][0] === 'Continue'
    ));
    send({type:'sent', requestId:value.requestId, ok:originalRoute && payload});
  }
  if (value.op === 'update') {
    const ok = value.messageId === '123' && value.route.chatId === 'chat' &&
      value.type === 'delta' && value.text === 'hel' && value.metadata.streamId === 'turn';
    send({type:'sent', requestId:value.requestId, ok});
  }
  if (value.op === 'stop') process.exit(0);
});
`;

test('worker credentials travel over stdin; inbound and outbound messages keep the original route', async t => {
  const controller = new AbortController();
  let received;
  let resolveMessage;
  const message = new Promise(resolve => { resolveMessage = resolve; });
  const statuses = [];
  let child;
  let runtimeDirectory;
  const oldSecret = process.env.SECRET_FROM_HOST;
  process.env.SECRET_FROM_HOST = 'host-only-simulated-secret';
  t.after(() => {
    if (oldSecret === undefined) delete process.env.SECRET_FROM_HOST;
    else process.env.SECRET_FROM_HOST = oldSecret;
  });
  const transport = createNanobotTransport('discord', { token: 'test-credential' }, {
    signal: controller.signal, allowedSenders: ['abc'], setStatus: status => statuses.push(status),
    onMessage: value => { received = value; resolveMessage(); },
  }, {
    python: 'python3',
    spawn(binary, args, opts) {
      assert.ok(!args.some(value => value.includes('test-credential')));
      runtimeDirectory = args.at(-1);
      child = spawn(process.execPath, ['-e', mockWorker], opts);
      return child;
    },
  });
  const run = transport.run();
  t.after(async () => { controller.abort(); await run; });
  await message;
  await transport.send(received, 'hello');
  await transport.sendUpdate({
    messageId: received.id, route: received.route, type: 'delta', text: 'hel', metadata: { streamId: 'turn' },
  });
  await transport.send({
    messageId: received.id, route: received.route, text: 'hello',
    attachments: [{ name: 'image.png', mime: 'image/png', data: 'cGljdHVyZQ==' }],
    metadata: { buttons: [['Continue']] },
  });
  const exited = once(child, 'close');
  await transport.stop();
  assert.deepEqual(await exited, [0, null]);
  await run;
  await assert.rejects(access(runtimeDirectory), { code: 'ENOENT' });
  assert.deepEqual(statuses, ['connected']);
});

test('Feishu instances select independent workers and route only to their own connection', async t => {
  const controller = new AbortController();
  const statuses = [];
  const messages = [];
  const started = Promise.withResolvers();
  const spawned = [];
  const worker = `
    const { createInterface } = require('node:readline');
    const emit = value => console.log(JSON.stringify(value));
    let instance;
    createInterface({input:process.stdin}).on('line', line => {
      const command = JSON.parse(line);
      if (command.op === 'start') {
        instance = command.instanceId;
        const valid = command.config.appId === 'app-' + instance &&
          command.allowedSenders.length === 1 && command.allowedSenders[0] === instance;
        if (!valid) process.exit(3);
        emit({type:'status', status:'connected'});
        const route = {chatId:'chat', senderId:instance, instanceId:instance};
        emit({type:'message', message:{id:instance, instanceId:instance, route}});
      }
      if (command.op === 'send') {
        emit({type:'sent', requestId:command.requestId, ok:command.route.instanceId === instance});
      }
      if (command.op === 'stop') process.exit(0);
    });
  `;
  const transport = createNanobotTransport('feishu', {
    instances: [
      { id: 'first', appId: 'app-first', appSecret: 'fake-secret', allowFrom: ['first', 'outside'] },
      { id: 'second', appId: 'app-second', appSecret: 'fake-secret', allowFrom: ['second'] },
    ],
  }, {
    signal: controller.signal, allowedSenders: ['first', 'second'],
    setStatus: status => statuses.push(status),
    onMessage(message) {
      messages.push(message);
      if (messages.length === 2) started.resolve();
    },
  }, {
    spawn(_python, args, options) {
      spawned.push(args.at(-1));
      return spawn(process.execPath, ['-e', worker], options);
    },
  });
  const run = transport.run();
  t.after(async () => { controller.abort(); await run; });
  await Promise.race([started.promise, run]);
  assert.equal(messages.length, 2);
  assert.equal(new Set(spawned).size, 2);
  assert.deepEqual(statuses, ['connecting', 'connected']);
  for (const message of messages) await transport.send({messageId: message.id, route: message.route, text: 'reply'});
  await assert.rejects(transport.send({messageId: 'forged', route: {chatId: 'chat'}, text: 'reply'}), {
    code: 'REPLY_ROUTE_INVALID',
  });
  await transport.stop();
  await run;
});
