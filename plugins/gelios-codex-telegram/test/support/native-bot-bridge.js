// Only the model endpoint is a local fixture; thread and turn records come
// from a real native app-server, in an isolated home with no API credentials.
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import readline from 'node:readline'
import { GeliosBridge as Bridge } from '../../scripts/bridge.js'
import { startAppServer } from './app-server.js'

export async function nativeBridge(t, root, workspace) {
  const provider = http.createServer(async (request, response) => {
    for await (const chunk of request) { /* Consume the request before answering. */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const item = { id: 'reply', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Received.', annotations: [] }] }
    for (const [event, data] of [
      ['response.created', { type: 'response.created', response: { id: 'response', status: 'in_progress', output: [] } }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response: { id: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ]) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    response.end()
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)) })
  const home = join(root, 'native-home'); mkdirSync(home)
  writeFileSync(join(home, 'config.toml'), `model = "gpt-5.5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`)
  const app = startAppServer(t, process.env.GELIOS_REAL_CODEX_BIN, { what: 'the native app server', cwd: workspace, env: { ...process.env, CODEX_HOME: home } })
  app.stderr.resume()
  await once(app, 'spawn')
  const bridge = new Bridge({ stateDir: join(root, 'state'), workspace })
  bridge.app = app; bridge.appReady = true; bridge.log = () => {}
  readline.createInterface({ input: app.stdout }).on('line', line => bridge.onAppLine(line))
  await bridge.rpc('initialize', { clientInfo: { name: 'bot-file-integration', version: '0' }, capabilities: { experimentalApi: true } })
  bridge.sendApp({ method: 'initialized' })
  const thread = (await bridge.rpc('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread
  bridge.bindThread(thread.id)
  return bridge
}
