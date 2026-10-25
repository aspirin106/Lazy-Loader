import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const options = Object.fromEntries(process.argv.slice(2).map((value, index, all) => index % 2 === 0 ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const event = value => { if (options.events) appendFileSync(options.events, JSON.stringify({ pid: process.pid, ...value }) + '\n'); };
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, value) => send({ id, result: value });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const pending = new Map();
let callbackId;
let worker;
let initParams;
let added = false;
if (options.mode === 'hang-close') {
  worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  setInterval(() => {}, 1000);
}
event({ event: 'start', worker: worker?.pid });
process.on('exit', () => event({ event: 'exit' }));

function tools() {
  let description = 'Test tool';
  if (options.schema) description = readFileSync(options.schema, 'utf8');
  return ['echo', 'sleep', 'fail', 'hang', 'crash', 'malformed', 'callback', 'notify_change',
    ...(options.mode === 'features' ? ['context', 'add_tool', 'resource_link', ...(added ? ['new_tool'] : [])] : [])].map(name => ({
    name, description, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
  }));
}

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (method) event({ event: 'message', method, tool: params.name });
  if (id === 'callback') {
    event({ event: 'callback', code: message.error?.code });
    result(callbackId, text({ code: message.error?.code, response: message.result }));
    return;
  }
  if (method === 'initialize') {
    initParams = params;
    const initialize = () => result(id, { protocolVersion: options.mode === 'negotiate' ? params.protocolVersion : '2025-11-25', capabilities: { tools: { listChanged: true },
      ...(options.mode === 'features' ? { prompts: { listChanged: true }, resources: { listChanged: true, subscribe: true }, completions: {}, experimental: { 'test/session-meta': {} } } : {}) }, serverInfo: { name: 'mock', version: '1.0.0' },
      ...(options.instructions ? { instructions: options.instructions } : {}) });
    if (options.mode === 'slow-init') setTimeout(initialize, 250);
    else initialize();
  }
  else if (method === 'tools/list') {
    if (options.mode === 'bad-list') { result(id, { tools: 'invalid' }); return; }
    const list = tools();
    result(id, params.cursor ? { tools: list.slice(4) } : { tools: list.slice(0, 4), nextCursor: 'rest' });
  } else if (method === 'prompts/list') result(id, { prompts: [{ name: 'guide', description: 'A session guide', arguments: [] }] });
  else if (method === 'resources/list') result(id, { resources: [{ uri: 'mock://state', name: 'state' }] });
  else if (method === 'resources/templates/list') result(id, { resourceTemplates: [{ uriTemplate: 'mock://{name}', name: 'template' }] });
  else if (method === 'resources/read') result(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'session state' }] });
  else if (method === 'resources/subscribe') { result(id, {}); send({method:'notifications/resources/updated',params:{uri:params.uri}}); }
  else if (method === 'prompts/get') result(id, { messages: [{ role: 'user', content: { type: 'text', text: params.name } }] });
  else if (method === 'completion/complete') result(id, { completion: { values: [params.ref.name], total: 1, hasMore: false } });
  else if (method === 'tools/call') {
    const name = params.name;
    if (name === 'crash') { process.exit(7); return; }
    if (name === 'malformed') { process.stdout.write('not-json\n'); return; }
    if (name === 'hang') { pending.set(id, null); return; }
    if (name === 'sleep') {
      if (params._meta?.progressToken !== undefined) send({ method: 'notifications/progress', params: { progressToken: params._meta.progressToken, progress: 0, total: 1 } });
      pending.set(id, setTimeout(() => {
        pending.delete(id);
        result(id, text({ pid: process.pid, arguments: params.arguments }));
      }, params.arguments?.ms ?? 200));
    } else if (name === 'fail') result(id, { isError: true, content: [{ type: 'text', text: 'Mock tool failure' }] });
    else if (name === 'context') result(id, text({ pid: process.pid, cwd: process.cwd(), initialize: initParams, private: process.env.MOCK_PRIVATE }));
    else if (name === 'resource_link') result(id, {content:[{type:'resource_link',uri:'mock://state',name:'state'}]});
    else if (name === 'add_tool') { added = true; send({ method: 'notifications/tools/list_changed' }); result(id, text({ added: true })); }
    else if (name === 'callback') {
      callbackId = id;
      send({ id: 'callback', method: params.arguments?.method ?? 'roots/list', params: params.arguments?.params ?? {} });
    } else {
      if (name === 'notify_change') send({ method: 'notifications/tools/list_changed' });
      result(id, text({ pid: process.pid, arguments: params.arguments }));
    }
  } else if (method === 'notifications/cancelled') {
    clearTimeout(pending.get(params.requestId));
    if (pending.has(params.requestId)) {
      pending.delete(params.requestId);
      send({ id: params.requestId, error: { code: -32800, message: 'Cancelled in mock' } });
    }
  } else if (method === 'ping') result(id, {});
});
input.on('close', () => { if (options.mode !== 'hang-close') process.exit(0); });
