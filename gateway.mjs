#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05'];
const MAX_LINE = 16 * 1024 * 1024;
const INFO = { name: 'mcp-lazy-gateway', version: '0.2.2' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' || Number.isSafeInteger(value);
const log = message => process.stderr.write(`[lazy-mcp] ${message}\n`);
const delay = ms => new Promise(done => setTimeout(done, ms));

export class RpcError extends Error {
  constructor(code, message, data, fatal = false) {
    super(message);
    this.code = code;
    this.data = data;
    this.fatal = fatal;
  }
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function keys(value, allowed, label) {
  requireThat(object(value), `${label} must be an object`);
  for (const key of Object.keys(value)) {
    requireThat(allowed.includes(key), `${label}: unknown key ${key}`);
  }
}

function seconds(value, fallback, label) {
  const result = value ?? fallback;
  requireThat(typeof result === 'number' && Number.isFinite(result) && result >= 0 && result <= 86400,
    `${label} must be a number between 0 and 86400`);
  return result;
}

export async function loadConfig(filename) {
  const base = dirname(resolve(filename));
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  keys(raw, ['version', 'servers'], 'config');
  requireThat(raw.version === 1 && object(raw.servers), 'Expected version: 1 and a servers object');
  const servers = new Map();
  const catalogs = new Set();
  for (const [alias, item] of Object.entries(raw.servers)) {
    requireThat(/^[a-z][a-z0-9_-]{0,31}$/.test(alias) && !alias.includes('__'), `Invalid server alias: ${alias}`);
    keys(item, ['command', 'args', 'cwd', 'env', 'envVars', 'catalog', 'idleSeconds', 'stateless', 'startupSeconds', 'timeoutSeconds', 'inheritCwd', 'dynamicTools', 'deferredDiscovery'], alias);
    requireThat(typeof item.command === 'string' && item.command.trim() && !/[\r\n\0]/.test(item.command), `${alias}: command is required`);
    requireThat(!/\.(cmd|bat)$/i.test(item.command), `${alias}: use the actual executable, not a .cmd/.bat wrapper`);
    const args = item.args ?? [];
    requireThat(Array.isArray(args) && args.every(arg => typeof arg === 'string' && !arg.includes('\0')), `${alias}: args must be strings`);
    requireThat(item.cwd === undefined || typeof item.cwd === 'string', `${alias}: cwd must be a string`);
    for (const key of ['inheritCwd','dynamicTools','deferredDiscovery']) requireThat(item[key] === undefined || typeof item[key] === 'boolean', `${alias}: ${key} must be boolean`);
    requireThat(!item.inheritCwd || item.cwd === undefined, `${alias}: inherited cwd cannot also specify cwd`);
    const cwd = item.inheritCwd ? process.cwd() : resolve(base, item.cwd ?? '.');
    requireThat((await stat(cwd)).isDirectory(), `${alias}: cwd must be a directory`);
    requireThat(typeof item.catalog === 'string' && item.catalog.trim(), `${alias}: catalog path is required`);
    const catalog = resolve(base, item.catalog);
    const catalogKey = process.platform === 'win32' ? catalog.toLowerCase() : catalog;
    const configKey = process.platform === 'win32' ? resolve(filename).toLowerCase() : resolve(filename);
    requireThat(catalogKey !== configKey && !catalogs.has(catalogKey), `${alias}: catalog must be unique and separate from the config file`);
    catalogs.add(catalogKey);
    const env = item.env ?? {};
    const envVars = item.envVars ?? [];
    requireThat(Array.isArray(envVars) && envVars.every(key => typeof key === 'string' && key && !/[=\0]/.test(key)), `${alias}: envVars must be environment variable names`);
    requireThat(object(env) && Object.entries(env).every(([key, value]) => key && !/[=\0]/.test(key) && typeof value === 'string' && !value.includes('\0')),
      `${alias}: env must contain string values`);
    requireThat(item.stateless === undefined || typeof item.stateless === 'boolean', `${alias}: stateless must be boolean`);
    const idleSeconds = seconds(item.idleSeconds, 0, `${alias}.idleSeconds`);
    requireThat(idleSeconds === 0 || item.stateless === true, `${alias}: automatic idle shutdown requires stateless: true`);
    const startupSeconds = seconds(item.startupSeconds, 30, `${alias}.startupSeconds`);
    const timeoutSeconds = seconds(item.timeoutSeconds, 120, `${alias}.timeoutSeconds`);
    requireThat(startupSeconds > 0 && timeoutSeconds > 0, `${alias}: request timeouts must be positive`);
    let command = item.command;
    if (!isAbsolute(command) && /[/\\]/.test(command)) command = resolve(cwd, command);
    const launchHash = createHash('sha256').update(JSON.stringify({ command, args, cwd: item.inheritCwd ? '<client-project>' : cwd, env, ...(envVars.length ? { envVars } : {}) })).digest('hex');
    servers.set(alias, { alias, command, args, cwd, env, catalog,
      idleSeconds, startupSeconds, timeoutSeconds, launchHash,
      envVars, inheritCwd: item.inheritCwd === true, dynamicTools: item.dynamicTools === true, deferredDiscovery: item.deferredDiscovery === true });
  }
  const managedEnvVars = [...new Set([...servers.values()].flatMap(config => config.envVars))];
  for (const config of servers.values()) config.managedEnvVars = managedEnvVars;
  return servers;
}

function validateTools(tools, alias) {
  requireThat(Array.isArray(tools), 'tools/list must return a tools array');
  const names = new Set();
  for (const tool of tools) {
    requireThat(object(tool) && typeof tool.name === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name), 'Invalid tool name');
    requireThat(!names.has(tool.name), `Duplicate tool: ${tool.name}`);
    requireThat(!alias || `${alias}__${tool.name}`.length <= 128, `${tool.name}: public tool name exceeds 128 characters`);
    requireThat(object(tool.inputSchema) && tool.inputSchema.type === 'object', `${tool.name}: inputSchema must have type object`);
    requireThat(tool.description === undefined || typeof tool.description === 'string', `${tool.name}: invalid description`);
    requireThat(tool.execution?.taskSupport !== 'required', `${tool.name}: task-only tools are unsupported`);
    names.add(tool.name);
  }
  return tools;
}

export async function readCatalog(config) {
  let cache;
  try { cache = JSON.parse(await readFile(config.catalog, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && config.deferredDiscovery) return {
      version: 1, launchHash: config.launchHash, protocolVersion: VERSIONS[0], deferred: true,
      serverInfo: { name: config.alias, version: 'deferred' }, capabilities: { tools: { listChanged: true } },
      tools: [{ name: 'connect', description: `Connect to ${config.alias} when its external application is ready, then discover its actual tools. Does not launch the application.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }],
    };
    throw new Error(`${config.alias}: missing or invalid catalog; run snapshot explicitly first`);
  }
  requireThat(cache.version === 1 && cache.launchHash === config.launchHash, `${config.alias}: catalog does not match launch settings; run snapshot again`);
  requireThat(VERSIONS.includes(cache.protocolVersion), `${config.alias}: unsupported cached protocol version`);
  requireThat(object(cache.serverInfo) && typeof cache.serverInfo.name === 'string' && typeof cache.serverInfo.version === 'string', `${config.alias}: invalid cached serverInfo`);
  requireThat(cache.instructions === undefined || typeof cache.instructions === 'string', `${config.alias}: invalid cached instructions`);
  validateTools(cache.tools, config.alias);
  return cache;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function toolSignature(tools) {
  return JSON.stringify(canonical([...tools].sort((a, b) => a.name.localeCompare(b.name))));
}

// shortcut: 16 MiB per JSON line; increase only if a measured tool response needs more.
function readMessages(stream, onMessage, onError) {
  let buffer = '';
  let failed = false;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    if (failed) return;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > MAX_LINE) {
        failed = true;
        onError(new Error('JSON line exceeds 16 MiB'));
        return;
      }
      try { onMessage(JSON.parse(line)); }
      catch (error) { onError(error); }
    }
    if (Buffer.byteLength(buffer) > MAX_LINE) {
      failed = true;
      onError(new Error('JSON line exceeds 16 MiB'));
    }
  });
  stream.on('end', () => {
    if (!failed && buffer.trim()) onError(new Error('Truncated JSON line'));
  });
  stream.on('error', onError);
}

async function terminate(child, exited) {
  child.stdin.end();
  if (await Promise.race([exited.then(() => true), delay(750).then(() => false)])) return;
  if (process.platform === 'win32') {
    // Only the owned child PID and its tree are targets; never kill by executable name.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    await new Promise(done => { killer.once('error', done); killer.once('exit', done); });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    if (!await Promise.race([exited.then(() => true), delay(750).then(() => false)])) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
  const stopped = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
  if (!stopped) throw new Error('Owned MCP process did not exit after shutdown');
}

class Client {
  constructor(config, onNotification = () => {}, onRequest, initialize, onClose = () => {}) {
    this.config = config;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.initialize = initialize;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (config.managedEnvVars?.some(managed => managed.toLowerCase() === key.toLowerCase())
        && !config.envVars?.some(allowed => allowed.toLowerCase() === key.toLowerCase())) delete env[key];
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (process.platform === 'win32') {
        for (const inherited of Object.keys(env)) if (inherited.toLowerCase() === key.toLowerCase()) delete env[inherited];
      }
      env[key] = value;
    }
    this.child = spawn(config.command, config.args, { cwd: config.cwd, env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(done => {
      this.child.once('exit', () => { this.fail(new Error('MCP process exited; request was not retried')); done(); });
      this.child.once('error', () => { this.fail(new Error('Cannot start MCP executable')); done(); });
    });
    this.child.stdin.on('error', () => this.fail(new Error('MCP input stream closed')));
    // Drain backend stderr without recording arguments, results, credentials, or backend log contents.
    this.child.stderr.resume();
    readMessages(this.child.stdout, message => this.receive(message), () => this.fail(new Error('Invalid MCP JSON-RPC output')));
    this.child.stdout.on('end', () => this.fail(new Error('MCP output stream closed')));
    log(`${config.alias}: started PID ${this.child.pid ?? 'unavailable'}`);
  }

  fail(error) {
    this.failure ??= new RpcError(-32000, error.message, undefined, true);
    for (const pending of [...this.pending.values()]) pending.finish(this.failure);
  }

  send(message) {
    if (this.closed || this.failure || !this.child.stdin.writable) throw this.failure ?? new RpcError(-32000, 'MCP connection is closed', undefined, true);
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE) throw new RpcError(-32602, 'Request exceeds 16 MiB');
    this.child.stdin.write(line);
  }

  receive(message) {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Invalid RPC envelope');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        requireThat(validId(message.id), 'Invalid server request ID');
        if (message.method === 'ping') this.send({ jsonrpc: '2.0', id: message.id, result: {} });
        else if (this.onRequest) this.onRequest(message, this);
        else this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Gateway does not support client capabilities' } });
      } else this.onNotification(message);
      return;
    }
    requireThat(validId(message.id) && (Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error')), 'Invalid RPC response');
    if (message.error) requireThat(object(message.error) && Number.isInteger(message.error.code) && typeof message.error.message === 'string', 'Invalid RPC error');
    this.pending.get(message.id)?.finish(message.error
      ? new RpcError(message.error.code, message.error.message, message.error.data)
      : null, message.result);
  }

  request(method, params, timeoutSeconds, signal, upstreamId) {
    const id = this.nextId++;
    return new Promise((done, reject) => {
      let timer;
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        error ? reject(error) : done(result);
      };
      const abort = () => {
        try { if (method !== 'initialize') this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }); } catch { /* Connection already closed. */ }
        finish(new RpcError(-32800, 'Request cancelled; backend will be stopped, with no replay', undefined, true));
      };
      if (signal?.aborted) { finish(new RpcError(-32800, 'Request cancelled before dispatch')); return; }
      this.pending.set(id, { finish, upstreamId });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        try { if (method !== 'initialize') this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }); } catch { /* Connection already closed. */ }
        finish(new RpcError(-32000, 'MCP request timed out; outcome may be unknown, request was not retried', undefined, true));
      }, timeoutSeconds * 1000);
      try { this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { finish(error); }
    });
  }

  async discover() {
    const { startupSeconds } = this.config;
    const initialized = await this.request('initialize', this.initialize ?? { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: INFO }, startupSeconds);
    requireThat(object(initialized) && VERSIONS.includes(initialized.protocolVersion), 'Unsupported MCP protocol version');
    requireThat(object(initialized.capabilities?.tools), 'Backend does not advertise tools');
    requireThat(object(initialized.serverInfo) && typeof initialized.serverInfo.name === 'string' && typeof initialized.serverInfo.version === 'string', 'Invalid MCP serverInfo');
    requireThat(initialized.instructions === undefined || typeof initialized.instructions === 'string', 'Invalid MCP instructions');
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = await this.listTools();
    const extras = {};
    for (const [capability, method, key] of [['prompts','prompts/list','prompts'],['resources','resources/list','resources'],['resources','resources/templates/list','resourceTemplates']]) {
      if (initialized.capabilities[capability]) extras[key] = await this.listPages(method, key);
    }
    return { protocolVersion: initialized.protocolVersion, serverInfo: initialized.serverInfo, capabilities: initialized.capabilities,
      ...(initialized.instructions ? { instructions: initialized.instructions } : {}), tools, ...extras };
  }

  async listPages(method, key) {
    const items = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await this.request(method, cursor === undefined ? {} : { cursor }, this.config.startupSeconds);
      requireThat(object(page), 'Invalid tools/list result');
      requireThat(Array.isArray(page[key]), `${method} must return a ${key} array`);
      items.push(...page[key]);
      cursor = page.nextCursor;
      requireThat(cursor === undefined || (typeof cursor === 'string' && cursor && !cursors.has(cursor) && cursors.size < 1000), 'Invalid or looping tools/list cursor');
      cursors.add(cursor);
    } while (cursor !== undefined);
    return items;
  }

  async listTools() { return validateTools(await this.listPages('tools/list', 'tools')); }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.onClose(this);
    this.fail(new Error('MCP connection stopped'));
    this.closing = terminate(this.child, this.exited);
    await this.closing;
    log(`${this.config.alias}: stopped`);
  }
}

export async function snapshot(config) {
  const client = new Client(config);
  let cache;
  try { cache = { version: 1, launchHash: config.launchHash, capturedAt: new Date().toISOString(), ...await client.discover() }; }
  finally { await client.close(); }
  validateTools(cache.tools, config.alias);
  const temporary = `${config.catalog}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(cache, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, config.catalog);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return cache;
}

class Backend {
  constructor(config, cache, notify, session = {}) {
    this.config = config;
    this.cache = cache;
    this.notify = notify;
    this.session = session;
    this.queue = Promise.resolve();
    this.jobs = 0;
  }

  async start() {
    if (this.client) return this.client;
    const client = new Client(this.config, message => {
      if (message.method === 'notifications/tools/list_changed') {
        this.dirty = true;
        if (this.config.dynamicTools) this.notify(message);
      }
      if (message.method === 'notifications/progress' && this.progressToken !== undefined && message.params?.progressToken === this.progressToken) this.notify(message);
      if (['notifications/message','notifications/prompts/list_changed'].includes(message.method)) this.notify(message);
      if (message.method === 'notifications/resources/updated') this.notify({ ...message, params: { ...message.params, uri: `mcp-lazy://${this.config.alias}/${message.params.uri}` } });
    }, this.session.onRequest, this.session.initialize, this.session.onClose);
    this.client = client;
    try {
      this.dirty = false;
      const live = await client.discover();
      requireThat(this.config.dynamicTools || this.cache.deferred || (toolSignature(live.tools) === toolSignature(this.cache.tools)
        && live.serverInfo.name === this.cache.serverInfo.name && live.serverInfo.version === this.cache.serverInfo.version
        && live.instructions === this.cache.instructions), 'MCP catalog changed; refresh snapshot and restart gateway before calling tools');
      if (this.config.dynamicTools || this.cache.deferred) {
        this.liveInstructions = live.instructions !== this.cache.instructions ? live.instructions : undefined;
        Object.assign(this.cache, live, { deferred: false });
        this.notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
      if (this.session.loggingLevel && live.capabilities.logging) await client.request('logging/setLevel', { level: this.session.loggingLevel }, this.config.startupSeconds);
      return client;
    } catch (error) { await this.stop(); throw error; }
  }

  call(params, signal, upstreamId) { return this.request('tools/call', params, signal, upstreamId); }

  request(method, params, signal, upstreamId) {
    this.jobs++;
    clearTimeout(this.idleTimer);
    const task = this.queue.then(async () => {
      if (signal.aborted) throw new RpcError(-32800, 'Request cancelled before dispatch');
      const expected = this.cache.tools.find(tool => tool.name === params.name);
      const connecting = this.cache.deferred && method === 'tools/call' && params.name === 'connect';
      const client = await this.start();
      if (connecting) {
        const instructions = this.liveInstructions; this.liveInstructions = undefined;
        return { content: [{ type: 'text', text: `Connected to ${this.config.alias}; refresh the tool list to use its actual tools.\n${instructions ?? ''}` }] };
      }
      if (this.dirty && !this.config.dynamicTools) throw new Error('MCP tool list changed; refresh snapshot and restart gateway');
      if (this.dirty) { this.cache.tools = await client.listTools(); this.dirty = false; }
      if (method === 'tools/call' && this.config.dynamicTools) {
        const actual = this.cache.tools.find(tool => tool.name === params.name);
        requireThat(expected && actual && toolSignature([expected]) === toolSignature([actual]), 'Tool schema changed; refresh the tool list before calling again');
      }
      this.progressToken = params._meta?.progressToken;
      try {
        const result = await client.request(method, params, this.config.timeoutSeconds, signal, upstreamId);
        if (method === 'tools/call') {
          requireThat(object(result) && Array.isArray(result.content) && (result.isError === undefined || typeof result.isError === 'boolean'), 'Invalid tools/call result; request was not retried');
          if (this.liveInstructions) { result.content.unshift({ type: 'text', text: `[${this.config.alias} session instructions]\n${this.liveInstructions}` }); this.liveInstructions = undefined; }
        }
        return result;
      } catch (error) {
        if (error.fatal || !(error instanceof RpcError)) await this.stop();
        throw error;
      } finally { this.progressToken = undefined; }
    });
    this.queue = task.catch(() => {});
    return task.finally(() => {
      this.jobs--;
      if (!this.jobs && this.client && this.config.idleSeconds > 0) {
        this.idleTimer = setTimeout(() => {
          // Put shutdown in the same queue so an arriving call waits for a clean restart.
          this.queue = this.queue.then(() => this.stop());
          this.queue.catch(error => log(`${this.config.alias}: ${error.message}`));
        }, this.config.idleSeconds * 1000);
      }
    });
  }

  async stop() {
    clearTimeout(this.idleTimer);
    const client = this.client;
    if (client) {
      await client.close();
      if (this.client === client) this.client = undefined;
    }
  }
}

export async function serve(configs, input = process.stdin, output = process.stdout) {
  const tools = new Map();
  const backends = new Map();
  let closing = false;
  let phase = 'new';
  const inflight = new Map();
  const callbacks = new Map();
  let callbackId = 0;
  const session = {};
  const withInstructions = (item, backend) => backend.cache.instructions
    ? { ...item, description: [item.description, `[${backend.config.alias} server instructions]\n${backend.cache.instructions}`].filter(Boolean).join('\n\n') }
    : item;
  const send = message => { if (!closing) output.write(JSON.stringify(message) + '\n'); };
  const errorResponse = (id, error) => send({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } });
  session.onRequest = (message, client) => {
    const capability = { 'roots/list': 'roots', 'elicitation/create': 'elicitation', 'sampling/createMessage': 'sampling' }[message.method];
    if (!capability || !session.initialize?.capabilities[capability]) {
      client.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client did not advertise this capability' } });
      return;
    }
    const id = `lazy-callback:${++callbackId}`;
    const timer = setTimeout(() => {
      callbacks.delete(id);
      try { client.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Client callback timed out' } }); } catch { /* Backend already closed. */ }
      send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    }, client.config.timeoutSeconds * 1000);
    callbacks.set(id, { client, originalId: message.id, timer });
    const params = { ...(message.params ?? {}) };
    if (params._meta?.relatedRequestId !== undefined) {
      const upstream = client.pending.get(params._meta.relatedRequestId)?.upstreamId;
      if (upstream !== undefined) params._meta = { ...params._meta, relatedRequestId: upstream };
    }
    send({ ...message, id, params });
  };
  session.onClose = client => {
    for (const [id, callback] of callbacks) if (callback.client === client) {
      clearTimeout(callback.timer); callbacks.delete(id);
      send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    }
  };
  for (const config of configs.values()) {
    const cache = await readCatalog(config);
    const backend = new Backend(config, cache, send, session);
    backends.set(config.alias, backend);
    for (const tool of cache.tools) {
      const name = `${config.alias}__${tool.name}`;
      requireThat(name.length <= 128 && !tools.has(name), `Invalid or duplicate public tool name: ${name}`);
      const publicTool = { ...withInstructions(tool, backend), name };
      delete publicTool.execution;
      tools.set(name, { backend, original: tool.name, publicTool });
    }
  }

  const uriFor = (alias, uri) => `mcp-lazy://${alias}/${uri}`;
  function resourceTarget(uri) {
    const match = typeof uri === 'string' && /^mcp-lazy:\/\/([^/]+)\/(.*)$/s.exec(uri);
    if (!match || !backends.has(match[1])) throw new RpcError(-32602, 'Unknown gateway resource');
    return { backend: backends.get(match[1]), uri: match[2] };
  }
  async function refreshTools() {
    tools.clear();
    for (const backend of backends.values()) {
      if (backend.dirty && backend.config.dynamicTools && backend.client) {
        backend.cache.tools = await backend.client.listTools(); backend.dirty = false;
      }
      for (const tool of validateTools(backend.cache.tools, backend.config.alias)) {
        const name = `${backend.config.alias}__${tool.name}`;
        const publicTool = { ...withInstructions(tool, backend), name }; delete publicTool.execution;
        tools.set(name, { backend, original: tool.name, publicTool });
      }
    }
  }
  function promptTarget(name) {
    for (const backend of backends.values()) {
      const prefix = backend.config.alias + '__';
      if (typeof name === 'string' && name.startsWith(prefix) && backend.cache.prompts?.some(prompt => prompt.name === name.slice(prefix.length))) {
        return { backend, name: name.slice(prefix.length) };
      }
    }
    throw new RpcError(-32602, 'Unknown gateway prompt');
  }

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const callback of callbacks.values()) clearTimeout(callback.timer);
    callbacks.clear();
    for (const controller of inflight.values()) controller.abort();
    const stopped = await Promise.allSettled([...backends.values()].map(backend => backend.stop()));
    for (const result of stopped) if (result.status === 'rejected') { log(result.reason.message); process.exitCode = 1; }
    input.pause();
  };

  async function receive(message) {
    if (closing) return;
    if (object(message) && message.jsonrpc === '2.0' && !message.method && validId(message.id)) {
      const callback = callbacks.get(message.id);
      if (!callback) return;
      if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) return;
      clearTimeout(callback.timer); callbacks.delete(message.id);
      try { callback.client.send({ jsonrpc: '2.0', id: callback.originalId,
        ...(message.error ? { error: message.error } : { result: message.result }) }); } catch { /* Backend was closed by cancellation. */ }
      return;
    }
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      errorResponse(null, new RpcError(-32600, 'Invalid JSON-RPC request'));
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      if (message.method === 'notifications/cancelled' && validId(message.params?.requestId)) inflight.get(message.params.requestId)?.abort();
      if (message.method === 'notifications/roots/list_changed') {
        for (const backend of backends.values()) if (backend.client && !backend.client.failure) backend.client.send(message);
      }
      return;
    }
    const { id, method } = message;
    if (!validId(id)) { errorResponse(null, new RpcError(-32600, 'Invalid request ID')); return; }
    if (inflight.has(id)) { errorResponse(id, new RpcError(-32600, 'Duplicate active request ID')); return; }
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      if (message.params !== undefined && !object(message.params)) throw new RpcError(-32602, 'params must be an object');
      const params = message.params ?? {};
      let result;
      if (method === 'initialize') {
        if (phase !== 'new') throw new RpcError(-32600, 'Already initialized');
        if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) throw new RpcError(-32602, 'Invalid initialize parameters');
        phase = 'initializing';
        const protocolVersion = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
        session.initialize = { ...params, protocolVersion, capabilities: { ...params.capabilities } };
        delete session.initialize.capabilities.tasks;
        const caches = [...backends.values()].map(backend => backend.cache);
        const capabilities = { tools: { listChanged: [...configs.values()].some(config => config.dynamicTools || config.deferredDiscovery) } };
        for (const category of ['prompts', 'resources', 'logging', 'completions']) {
          if (caches.some(cache => cache.capabilities?.[category])) capabilities[category] = category === 'prompts' || category === 'resources' ? { listChanged: true } : {};
        }
        const experimental = Object.assign({}, ...caches.map(cache => cache.capabilities?.experimental ?? {}));
        if (Object.keys(experimental).length) capabilities.experimental = experimental;
        result = { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
          capabilities, serverInfo: INFO,
          instructions: 'Tools use server__tool names. Backends may stop when idle; do not assume session state persists.' };
      } else if (method === 'ping') result = {};
      else {
        if (phase !== 'ready') throw new RpcError(-32000, 'Initialize and send notifications/initialized first');
        if (method === 'tools/list') {
          if (params.cursor !== undefined) throw new RpcError(-32602, 'This catalog has no cursor');
          await refreshTools();
          result = { tools: [...tools.values()].map(tool => tool.publicTool) };
        } else if (method === 'tools/call') {
          if (typeof params.name !== 'string' || !tools.has(params.name)) throw new RpcError(-32602, 'Unknown tool');
          if (params.arguments !== undefined && !object(params.arguments)) throw new RpcError(-32602, 'arguments must be an object');
          if (params.task !== undefined) throw new RpcError(-32602, 'Task-augmented calls are unsupported');
          if (params._meta !== undefined && !object(params._meta)) throw new RpcError(-32602, '_meta must be an object');
          if (params._meta?.progressToken !== undefined && !validId(params._meta.progressToken)) throw new RpcError(-32602, 'Invalid progressToken');
          const tool = tools.get(params.name);
          try {
            result = await tool.backend.call({ ...params, name: tool.original, arguments: params.arguments ?? {} }, controller.signal, id);
            for (const content of result.content ?? []) {
              if (content.type === 'resource_link') content.uri = uriFor(tool.backend.config.alias, content.uri);
              if (content.type === 'resource' && content.resource?.uri) content.resource.uri = uriFor(tool.backend.config.alias, content.resource.uri);
            }
          } catch (error) {
            result = { isError: true, content: [{ type: 'text', text: error.message }] };
          }
        } else if (method === 'prompts/list' && [...backends.values()].some(backend => backend.cache.capabilities?.prompts)) {
          if (params.cursor !== undefined) throw new RpcError(-32602, 'This catalog has no cursor');
          result = { prompts: [...backends.values()].flatMap(backend => (backend.cache.prompts ?? []).map(prompt => ({ ...withInstructions(prompt, backend), name: backend.config.alias + '__' + prompt.name }))) };
        } else if (method === 'prompts/get') {
          const target = promptTarget(params.name);
          result = await target.backend.request(method, { ...params, name: target.name }, controller.signal, id);
        } else if (['resources/list','resources/templates/list'].includes(method) && [...backends.values()].some(backend => backend.cache.capabilities?.resources)) {
          if (params.cursor !== undefined) throw new RpcError(-32602, 'This catalog has no cursor');
          const key = method === 'resources/list' ? 'resources' : 'resourceTemplates';
          const field = key === 'resources' ? 'uri' : 'uriTemplate';
          result = { [key]: [...backends.values()].flatMap(backend => (backend.cache[key] ?? []).map(resource => ({ ...withInstructions(resource, backend), [field]: uriFor(backend.config.alias, resource[field]) }))) };
        } else if (['resources/read','resources/subscribe','resources/unsubscribe'].includes(method)) {
          const target = resourceTarget(params.uri);
          result = await target.backend.request(method, { ...params, uri: target.uri }, controller.signal, id);
          if (result.contents) result.contents = result.contents.map(content => ({ ...content, uri: uriFor(target.backend.config.alias, content.uri) }));
        } else if (method === 'completion/complete') {
          const target = params.ref?.type === 'ref/prompt' ? promptTarget(params.ref.name) : resourceTarget(params.ref?.uri);
          result = await target.backend.request(method, { ...params, ref: { ...params.ref, ...(target.name ? { name: target.name } : { uri: target.uri }) } }, controller.signal, id);
        } else if (method === 'logging/setLevel') {
          if (typeof params.level !== 'string') throw new RpcError(-32602, 'Logging level must be a string');
          session.loggingLevel = params.level;
          for (const backend of backends.values()) if (backend.client && backend.cache.capabilities?.logging) await backend.client.request(method, params, backend.config.timeoutSeconds);
          result = {};
        } else throw new RpcError(-32601, 'Method not supported by gateway');
      }
      send({ jsonrpc: '2.0', id, result });
    } catch (error) { errorResponse(id, error); }
    finally { inflight.delete(id); }
  }

  readMessages(input, message => { receive(message).catch(error => { log(error.message); shutdown(); }); }, error => errorResponse(null, new RpcError(-32700, error.message)));
  input.once('end', shutdown);
  input.once('error', shutdown);
  output.once('error', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { shutdown };
}

async function main() {
  const [mode, filename, alias, ...extra] = process.argv.slice(2);
  if (!['serve', 'snapshot', 'check'].includes(mode) || !filename || extra.length || (mode !== 'snapshot' && alias) || (mode === 'snapshot' && !alias)) {
    throw new Error('Usage: node gateway.mjs serve|check CONFIG.json  OR  node gateway.mjs snapshot CONFIG.json SERVER');
  }
  const configs = await loadConfig(filename);
  if (mode === 'serve') await serve(configs);
  else if (mode === 'snapshot') {
    requireThat(configs.has(alias), 'Unknown server alias');
    const cache = await snapshot(configs.get(alias));
    console.log(JSON.stringify({ server: alias, tools: cache.tools.length, catalog: configs.get(alias).catalog }));
  } else {
    const summary = [];
    for (const config of configs.values()) {
      const cache = await readCatalog(config);
      summary.push({ server: config.alias, tools: cache.tools.length, idleSeconds: config.idleSeconds });
    }
    console.log(JSON.stringify({ valid: true, startedBackends: 0, servers: summary }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { log(error.message); process.exitCode = 1; });
}
