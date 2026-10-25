import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { loadConfig, readCatalog, snapshot } from '../gateway.mjs';

test('lazy session forwards client capabilities and routes colliding backend callback IDs to the right backend', async t => {
  const f = await fixture(t, { args: [resolve(root, 'test/mock-server.mjs'), '--mode', 'features'], idleSeconds: 0, stateless: false }, ['one','two']);
  await f.prepare();
  const h=f.start();
  const requests=[];
  h.onRequest=message=>{ requests.push(message); return message.method==='roots/list' ? { roots: [{ uri:'file:///project' }] } : { action:'decline' }; };
  const init=await h.initialize('2025-11-25',{roots:{listChanged:true},elicitation:{form:{}}});
  assert.deepEqual(init.result.capabilities.experimental, {'test/session-meta':{}});
  const [a,b]=await Promise.all([h.call('one__callback'),h.call('two__callback')]);
  assert.equal(a.result.structuredContent.response.roots[0].uri,'file:///project');
  assert.equal(b.result.structuredContent.response.roots[0].uri,'file:///project');
  assert.equal(new Set(requests.map(r=>r.id)).size,2);
  const elicitation=await h.call('one__callback',{method:'elicitation/create',params:{message:'Confirm?',requestedSchema:{type:'object'}}});
  assert.equal(elicitation.result.structuredContent.response.action,'decline');
  const context=(await h.call('one__context')).result.structuredContent;
  assert.deepEqual(context.initialize.capabilities.roots,{listChanged:true});
  assert.equal(context.initialize.clientInfo.name,'test');
});

test('prompt catalog does not start a backend and prompt completion keeps the same session', async t => {
  const f=await fixture(t,{args:[resolve(root,'test/mock-server.mjs'),'--mode','features'],idleSeconds:0,stateless:false});
  await f.prepare();const h=f.start();await h.initialize();
  assert.equal((await h.rpc('prompts/list')).result.prompts[0].name,'demo__guide');
  assert.equal(h.stderr.includes('started PID'),false);
  assert.equal((await h.rpc('prompts/get',{name:'demo__guide'})).result.messages[0].content.text,'guide');
  assert.deepEqual((await h.rpc('completion/complete',{ref:{type:'ref/prompt',name:'demo__guide'},argument:{name:'topic',value:'a'}})).result.completion.values,['guide']);
});

test('dynamic catalog refresh preserves a stateful backend and exposes newly announced tools', async t => {
  const f=await fixture(t,{args:[resolve(root,'test/mock-server.mjs'),'--mode','features'],idleSeconds:0,stateless:false,dynamicTools:true});
  await f.prepare();const h=f.start();await h.initialize();
  const pid=(await h.call('demo__context')).result.structuredContent.pid;
  await h.call('demo__add_tool');
  assert.ok(h.notifications.some(n=>n.method==='notifications/tools/list_changed'));
  const tools=(await h.rpc('tools/list')).result.tools;
  assert.ok(tools.some(tool=>tool.name==='demo__new_tool'));
  assert.equal((await h.call('demo__new_tool')).result.structuredContent.pid,pid);
});

test('a backend with inherited project cwd reuses a portable catalog and runs in the client project', async t => {
  const f=await fixture(t,{args:[resolve(root,'test/mock-server.mjs'),'--mode','features'],idleSeconds:0,stateless:false,inheritCwd:true});
  delete f.raw.servers.demo.cwd;await f.save();
  const configs=await f.prepare();assert.equal(configs.get('demo').cwd,process.cwd());
  const h=f.start();await h.initialize();
  assert.equal((await h.call('demo__context')).result.structuredContent.cwd,process.cwd());
});

test('host-only forwarded environment variables are not inherited by other backends', async t => {
  const old=process.env.MOCK_PRIVATE;process.env.MOCK_PRIVATE='host-only-value';
  t.after(()=>{if(old===undefined)delete process.env.MOCK_PRIVATE;else process.env.MOCK_PRIVATE=old;});
  const f=await fixture(t,{args:[resolve(root,'test/mock-server.mjs'),'--mode','features'],idleSeconds:0,stateless:false},['one','two']);
  f.raw.servers.one.envVars=['MOCK_PRIVATE'];await f.save();await f.prepare();
  const h=f.start();await h.initialize();
  assert.equal((await h.call('one__context')).result.structuredContent.private,'host-only-value');
  assert.equal((await h.call('two__context')).result.structuredContent.private,undefined);
});

test('an offline application has a lazy connect tool and discovers actual tools without invoking them', async t => {
  const f=await fixture(t,{args:[resolve(root,'test/mock-server.mjs'),'--mode','features'],idleSeconds:0,stateless:false,deferredDiscovery:true,dynamicTools:true});
  await f.prepare();await rm(resolve(f.dir,'demo.catalog.json'));
  const h=f.start();await h.initialize();
  assert.deepEqual((await h.rpc('tools/list')).result.tools.map(tool=>tool.name),['demo__connect']);
  assert.equal(h.stderr.includes('started PID'),false);
  assert.notEqual((await h.call('demo__connect')).result.isError,true);
  assert.ok((await h.rpc('tools/list')).result.tools.some(tool=>tool.name==='demo__context'));
  assert.equal((await h.call('demo__context')).result.structuredContent.initialize.clientInfo.name,'test');
});

test('resources and resource links retain their backend identity and subscriptions forward updates', async t => {
  const f=await fixture(t,{args:[resolve(root,'test/mock-server.mjs'),'--mode','features'],idleSeconds:0,stateless:false});
  await f.prepare();const h=f.start();await h.initialize();
  const uri=(await h.rpc('resources/list')).result.resources[0].uri;
  assert.equal(uri,'mcp-lazy://demo/mock://state');
  assert.equal(h.stderr.includes('started PID'),false);
  assert.equal((await h.rpc('resources/templates/list')).result.resourceTemplates[0].uriTemplate,'mcp-lazy://demo/mock://{name}');
  assert.equal((await h.rpc('resources/read',{uri})).result.contents[0].uri,uri);
  assert.equal((await h.call('demo__resource_link')).result.content[0].uri,uri);
  await h.rpc('resources/subscribe',{uri});
  await until(()=>h.notifications.some(n=>n.method==='notifications/resources/updated'));
  assert.equal(h.notifications.find(n=>n.method==='notifications/resources/updated').params.uri,uri);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(25); }
  assert.fail('Condition not reached before timeout');
}
async function events(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

class Harness {
  constructor(config) {
    this.child = spawn(process.execPath, [resolve(root, 'gateway.mjs'), 'serve', config], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.notifications = [];
    this.nextId = 1;
    this.stderr = '';
    this.child.stderr.setEncoding('utf8').on('data', chunk => { this.stderr += chunk; });
    this.exited = new Promise(done => this.child.once('exit', (code, signal) => {
      this.exitCode = code;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Gateway exited: ${code}/${signal}: ${this.stderr}`)); }
      this.pending.clear();
      done();
    }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method) {
        if (message.id !== undefined && this.onRequest) {
          Promise.resolve(this.onRequest(message)).then(result => this.send({ id: message.id, result }));
        } else this.notifications.push(message);
        return;
      }
      const item = this.pending.get(message.id);
      if (item) {
        clearTimeout(item.timer);
        this.pending.delete(message.id);
        item.done(message);
      }
    });
    this.child.stdin.on('error', () => {});
  }
  send(message) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  request(method, params, id = this.nextId++) {
    let done;
    let reject;
    const response = new Promise((resolve, fail) => { done = resolve; reject = fail; });
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No response for ${method}: ${this.stderr}`)); }, 15000);
    this.pending.set(id, { done, reject, timer });
    this.send({ id, method, ...(params === undefined ? {} : { params }) });
    return { id, response };
  }
  async rpc(method, params) { return this.request(method, params).response; }
  async initialize(version = '2025-11-25', capabilities = {}) {
    const response = await this.rpc('initialize', { protocolVersion: version, capabilities, clientInfo: { name: 'test', version: '1' } });
    assert.equal(response.result.serverInfo.name, 'mcp-lazy-gateway');
    this.send({ method: 'notifications/initialized' });
    return response;
  }
  call(name, args = {}, extra = {}) { return this.rpc('tools/call', { name, arguments: args, ...extra }); }
  async close() {
    if (this.exitCode !== undefined) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 12000);
    try { await this.exited; } finally { clearTimeout(timer); }
    assert.equal(this.exitCode, 0, this.stderr);
  }
}

async function fixture(t, overrides = {}, aliases = ['demo']) {
  const tempRoot = process.env.LAZY_MCP_TEST_ROOT ?? tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(resolve(tempRoot, 'lazy-mcp-test-'));
  const path = resolve(dir, 'config.json');
  const raw = { version: 1, servers: {} };
  const eventFiles = {};
  for (const alias of aliases) {
    const eventFile = resolve(dir, `${alias}.events`);
    eventFiles[alias] = eventFile;
    raw.servers[alias] = { command: process.execPath, args: [resolve(root, 'test/mock-server.mjs'), '--events', eventFile],
      cwd: dir, catalog: `${alias}.catalog.json`, idleSeconds: 0.15, stateless: true, startupSeconds: 3, timeoutSeconds: 4,
      ...overrides };
  }
  await writeFile(path, JSON.stringify(raw));
  let harness;
  t.after(async () => {
    await harness?.close();
    let leaked = false;
    for (const eventFile of Object.values(eventFiles)) {
      for (const item of await events(eventFile)) {
        if (item.event === 'start') {
          for (const pid of [item.pid, item.worker].filter(Boolean)) {
            if (alive(pid)) { leaked = true; try { process.kill(pid); } catch { /* Already exited. */ } }
          }
        }
      }
    }
    assert.equal(dirname(dir), resolve(tempRoot));
    await rm(dir, { recursive: true, force: true });
    assert.equal(leaked, false, 'Mock process leaked after gateway shutdown');
  });
  return { dir, path, raw, eventFiles,
    async prepare() {
      const configs = await loadConfig(path);
      for (const config of configs.values()) await snapshot(config);
      for (const eventFile of Object.values(eventFiles)) {
        for (const item of await events(eventFile)) {
          if (item.event === 'start') {
            for (const pid of [item.pid, item.worker].filter(Boolean)) await until(() => !alive(pid));
          }
        }
        await writeFile(eventFile, '');
      }
      return configs;
    },
    start() { harness = new Harness(path); return harness; },
    async save() { await writeFile(path, JSON.stringify(raw)); },
  };
}

test('initialize, list, and ping use only cached tools; malformed requests never start a backend', async t => {
  const f = await fixture(t);
  await f.prepare();
  const h = f.start();
  assert.equal((await h.rpc('tools/list')).error.code, -32000);
  const response = await h.initialize('unknown-client-version');
  assert.equal(response.result.protocolVersion, '2025-11-25');
  const list = (await h.rpc('tools/list')).result.tools;
  assert.equal(list.length, 8);
  assert.equal(list[0].name, 'demo__echo');
  assert.deepEqual((await h.rpc('ping')).result, {});
  assert.equal((await h.call('unknown__echo')).error.code, -32602);
  assert.equal((await h.call('demo__echo', [])).error.code, -32602);
  assert.equal((await h.call('demo__echo', {}, { task: {} })).error.code, -32602);
  assert.equal((await h.rpc('resources/list')).error.code, -32601);
  assert.equal((await h.rpc('tools/list', { cursor: 'invented' })).error.code, -32602);
  assert.equal((await h.rpc('initialize', {})).error.code, -32600);
  assert.deepEqual(await events(f.eventFiles.demo), []);
});

test('supported client protocol negotiation does not invalidate the cached catalog', async t => {
  const f = await fixture(t, { args: [resolve(root, 'test/mock-server.mjs'), '--mode', 'negotiate'] });
  await f.prepare();
  const cache = JSON.parse(await readFile(resolve(f.dir, 'demo.catalog.json'), 'utf8'));
  assert.equal(cache.protocolVersion, '2025-11-25');
  for (const protocolVersion of ['2025-06-18', '2024-11-05']) {
    const h = f.start();
    assert.equal((await h.initialize(protocolVersion)).result.protocolVersion, protocolVersion);
    const response = await h.call('demo__echo', { protocolVersion });
    assert.equal(response.result.isError, undefined, JSON.stringify(response));
    assert.deepEqual(response.result.structuredContent.arguments, { protocolVersion });
    await h.close();
  }
});

test('first tool call starts once, concurrent calls share the backend, idle stops it and later calls restart', async t => {
  const f = await fixture(t);
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const responses = await Promise.all([h.call('demo__echo', { secret: 'DO_NOT_LOG' }), h.call('demo__echo', { n: 2 })]);
  const first = responses[0].result.structuredContent;
  assert.equal(first.arguments.secret, 'DO_NOT_LOG');
  assert.equal(first.pid, responses[1].result.structuredContent.pid);
  assert.equal((await events(f.eventFiles.demo)).filter(item => item.event === 'start').length, 1);
  await until(() => !alive(first.pid));
  const next = (await h.call('demo__echo')).result.structuredContent;
  assert.notEqual(first.pid, next.pid);
  assert.equal(h.stderr.includes('DO_NOT_LOG'), false);
});

test('idle countdown waits for the full call and forwards progress and structured content', async t => {
  const f = await fixture(t);
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const response = h.call('demo__sleep', { ms: 500 }, { _meta: { progressToken: 'work-1' } });
  await until(async () => (await events(f.eventFiles.demo)).some(item => item.tool === 'sleep'));
  const pid = (await events(f.eventFiles.demo)).find(item => item.event === 'start').pid;
  await wait(300);
  assert.equal(alive(pid), true);
  assert.equal((await response).result.structuredContent.pid, pid);
  assert.equal(h.notifications[0].params.progressToken, 'work-1');
  await until(() => !alive(pid));
});

test('stateful mode keeps the process until EOF; backend tool errors pass through', async t => {
  const f = await fixture(t, { idleSeconds: 0, stateless: false });
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const pid = (await h.call('demo__echo')).result.structuredContent.pid;
  await wait(350);
  assert.equal(alive(pid), true);
  assert.equal((await h.call('demo__fail')).result.isError, true);
  assert.equal((await h.call('demo__echo')).result.structuredContent.pid, pid);
  await h.close();
  assert.equal(alive(pid), false);
});

test('multiple backends route separately and leave unused backends stopped', async t => {
  const f = await fixture(t, {}, ['one', 'two']);
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const slow = h.call('one__sleep', { ms: 500 });
  await until(async () => (await events(f.eventFiles.one)).some(item => item.tool === 'sleep'));
  assert.deepEqual(await events(f.eventFiles.two), []);
  const fast = await h.call('two__echo', { value: 'two' });
  assert.equal(fast.result.structuredContent.arguments.value, 'two');
  const first = await slow;
  assert.notEqual(first.result.structuredContent.pid, fast.result.structuredContent.pid);
});

test('cancelling a queued request never dispatches it; running request is left intact', async t => {
  const f = await fixture(t);
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const slow = h.call('demo__sleep', { ms: 300 });
  const queued = h.request('tools/call', { name: 'demo__echo', arguments: { never: true } });
  h.send({ method: 'notifications/cancelled', params: { requestId: queued.id } });
  assert.equal((await slow).result.isError, undefined);
  assert.equal((await queued.response).result.isError, true);
  assert.equal((await events(f.eventFiles.demo)).filter(item => item.tool === 'echo').length, 0);
});

test('cancelling an active call stops its backend without replay and permits a fresh later call', async t => {
  const f = await fixture(t);
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const active = h.request('tools/call', { name: 'demo__hang' });
  await until(async () => (await events(f.eventFiles.demo)).some(item => item.tool === 'hang'));
  const pid = (await events(f.eventFiles.demo)).find(item => item.event === 'start').pid;
  h.send({ method: 'notifications/cancelled', params: { requestId: active.id } });
  assert.equal((await active.response).result.isError, true);
  assert.equal(alive(pid), false);
  assert.notEqual((await h.call('demo__echo')).result.structuredContent.pid, pid);
  assert.equal((await events(f.eventFiles.demo)).filter(item => item.tool === 'hang').length, 1);
});

test('cancelling during startup never sends a tool call or cancellation for an unsent request', async t => {
  const f = await fixture(t);
  f.raw.servers.demo.args.push('--mode', 'slow-init');
  await f.save();
  await f.prepare();
  const h = f.start();
  await h.initialize();
  const active = h.request('tools/call', { name: 'demo__echo' });
  await until(async () => (await events(f.eventFiles.demo)).some(item => item.method === 'initialize'));
  h.send({ method: 'notifications/cancelled', params: { requestId: active.id } });
  assert.equal((await active.response).result.isError, true);
  const recorded = await events(f.eventFiles.demo);
  assert.equal(recorded.some(item => item.method === 'tools/call' || item.method === 'notifications/cancelled'), false);
  assert.equal((await h.call('demo__echo')).result.isError, undefined);
});

test('timeout, crash, and malformed backend messages fail once without automatic replay', async t => {
  const f = await fixture(t, { timeoutSeconds: 0.15 });
  await f.prepare();
  const h = f.start();
  await h.initialize();
  for (const tool of ['hang', 'crash', 'malformed']) {
    assert.equal((await h.call(`demo__${tool}`)).result.isError, true);
    assert.equal((await events(f.eventFiles.demo)).filter(item => item.tool === tool).length, 1);
  }
  assert.equal((await h.call('demo__echo')).result.isError, undefined);
});

test('schema drift blocks dispatch before a tool can run', async t => {
  const f = await fixture(t);
  const schema = resolve(f.dir, 'schema.txt');
  await writeFile(schema, 'Original schema');
  f.raw.servers.demo.args.push('--schema', schema);
  await f.save();
  await f.prepare();
  await writeFile(schema, 'Changed schema');
  const h = f.start();
  await h.initialize();
  const response = await h.call('demo__echo');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /catalog changed/);
  assert.equal((await events(f.eventFiles.demo)).some(item => item.method === 'tools/call'), false);
});

test('tool list notifications block later dispatch and unsupported server callbacks return explicit errors', async t => {
  const f = await fixture(t);
  await f.prepare();
  const h = f.start();
  await h.initialize();
  assert.equal((await h.call('demo__callback')).result.structuredContent.code, -32601);
  assert.equal((await h.call('demo__notify_change')).result.isError, undefined);
  assert.equal((await h.call('demo__echo')).result.isError, true);
  assert.equal((await events(f.eventFiles.demo)).some(item => item.tool === 'echo'), false);
});

test('configuration rejects unsafe idle settings and unknown keys; changed launches reject cached tools', async t => {
  const f = await fixture(t, { stateless: false });
  await assert.rejects(loadConfig(f.path), /stateless: true/);
  f.raw.servers.demo.stateless = true;
  f.raw.servers.demo.misspelled = true;
  await f.save();
  await assert.rejects(loadConfig(f.path), /unknown key/);
  delete f.raw.servers.demo.misspelled;
  f.raw.servers.demo.catalog = 'config.json';
  await f.save();
  await assert.rejects(loadConfig(f.path), /separate from the config/);
  f.raw.servers.demo.catalog = 'demo.catalog.json';
  await f.save();
  const configs = await f.prepare();
  assert.equal((await readCatalog(configs.get('demo'))).tools.length, 8);
  f.raw.servers.demo.args.push('--extra', 'different');
  await f.save();
  await assert.rejects(readCatalog((await loadConfig(f.path)).get('demo')), /does not match/);
  assert.deepEqual(await events(f.eventFiles.demo), []);
});

test('missing or corrupted catalogs fail before startup and a successful snapshot can refresh the file', async t => {
  const f = await fixture(t);
  const config = (await loadConfig(f.path)).get('demo');
  await assert.rejects(readCatalog(config), /missing or invalid catalog/);
  assert.deepEqual(await events(f.eventFiles.demo), []);
  await writeFile(config.catalog, 'broken');
  await assert.rejects(readCatalog(config), /missing or invalid catalog/);
  const first = await snapshot(config);
  const second = await snapshot(config);
  assert.deepEqual((await readCatalog(config)).tools, first.tools);
  assert.equal((await readCatalog(config)).capturedAt, second.capturedAt);
  assert.equal((await events(f.eventFiles.demo)).some(item => item.method === 'tools/call'), false);
});

test('failed explicit snapshot leaves the previous catalog unchanged', async t => {
  const f = await fixture(t);
  const configs = await f.prepare();
  const path = configs.get('demo').catalog;
  const before = await readFile(path, 'utf8');
  f.raw.servers.demo.args.push('--mode', 'bad-list');
  await f.save();
  await assert.rejects(snapshot((await loadConfig(f.path)).get('demo')), /tools array/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('forced shutdown kills only the owned process tree when a mock ignores stdin EOF', async t => {
  const f = await fixture(t, { idleSeconds: 0, stateless: false });
  f.raw.servers.demo.args.push('--mode', 'hang-close');
  await f.save();
  await f.prepare();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => unrelated.kill());
  const h = f.start();
  await h.initialize();
  await h.call('demo__echo');
  const started = (await events(f.eventFiles.demo)).find(item => item.event === 'start');
  assert.equal(alive(started.worker), true);
  await h.close();
  await until(() => !alive(started.worker));
  assert.equal(alive(started.pid), false);
  assert.equal(alive(unrelated.pid), true);
});
