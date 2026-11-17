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
    send({type:'sent', requestId:value.requestId, ok:value.messageId === '123' && value.route.chatId === 'chat' && value.text === 'hello'});
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
  const exited = once(child, 'close');
  await transport.stop();
  assert.deepEqual(await exited, [0, null]);
  await run;
  await assert.rejects(access(runtimeDirectory), { code: 'ENOENT' });
  assert.deepEqual(statuses, ['connected']);
});
