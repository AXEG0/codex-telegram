import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OpenAITranscriber, TRANSCRIPT_PREFIX } from '../src/transcription.js'

function fixture(t, name = 'clip.mp3', contents = 'audio bytes') {
  const dir = mkdtempSync(join(tmpdir(), 'gelios-transcription-test-'))
  const path = join(dir, name); writeFileSync(path, contents, { mode: 0o600 })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return path
}
function childThat(run) {
  const child = new EventEmitter(); child.kill = () => true
  queueMicrotask(() => { try { run(); child.emit('close', 0, null) } catch (error) { child.emit('error', error) } })
  return child
}

test('direct transcription sends only the fixed gpt-transcribe multipart request', async t => {
  const path = fixture(t)
  const secret = 'sk-direct-secret'; let request; let spawned = false
  const transcriber = new OpenAITranscriber({
    apiKey: secret,
    spawnImpl: () => { spawned = true },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ text: '  hello world  ' }) } },
  })
  assert.deepEqual(await transcriber.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg', duration: 12 }), { text: 'hello world' })
  assert.equal(TRANSCRIPT_PREFIX, '[Voice message, auto-transcribed — may contain transcription errors]')
  assert.equal(spawned, false)
  assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(request.options.headers, { Authorization: `Bearer ${secret}` })
  assert.equal(request.options.body.get('model'), 'gpt-transcribe')
  const file = request.options.body.get('file')
  assert.equal(file.name, 'clip.mp3'); assert.equal(file.type, 'audio/mpeg')
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'audio bytes')
})

test('all documented direct formats bypass ffmpeg, including MIME-derived names', async t => {
  const path = fixture(t, 'payload')
  let requests = 0; let spawns = 0
  const transcriber = new OpenAITranscriber({
    apiKey: 'key', spawnImpl: () => { spawns += 1 },
    fetchImpl: async (_url, { body }) => { requests += 1; assert.ok(body.get('file')); return { ok: true, json: async () => ({ text: 'ok' }) } },
  })
  for (const extension of ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm']) {
    assert.deepEqual(await transcriber.transcribe({ path, name: `voice.${extension}`, mime: 'application/octet-stream' }), { text: 'ok' })
  }
  assert.deepEqual(await transcriber.transcribe({ path, name: 'voice', mime: 'audio/mpeg; codecs=mp3' }), { text: 'ok' })
  assert.equal(requests, 8); assert.equal(spawns, 0)
})

test('OGG/Opus is securely remuxed to bounded WebM and its temporary directory is removed', async t => {
  const path = fixture(t, 'voice.ogg')
  const previousSecret = process.env.TEST_TRANSCRIPTION_CHILD_SECRET
  const previousPat = process.env.TEST_OPERATIONAL_PAT
  process.env.TEST_TRANSCRIPTION_CHILD_SECRET = 'key'; process.env.TEST_OPERATIONAL_PAT = 'operational-secret'
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TEST_TRANSCRIPTION_CHILD_SECRET; else process.env.TEST_TRANSCRIPTION_CHILD_SECRET = previousSecret
    if (previousPat === undefined) delete process.env.TEST_OPERATIONAL_PAT; else process.env.TEST_OPERATIONAL_PAT = previousPat
  })
  let command; let temporaryDir; let uploaded
  const spawnImpl = (bin, args, options) => childThat(() => {
    command = { bin, args, options }
    const output = args.at(-1); temporaryDir = join(output, '..')
    assert.equal(statSync(output).mode & 0o777, 0o600)
    writeFileSync(output, 'webm bytes')
  })
  const transcriber = new OpenAITranscriber({
    apiKey: 'key', ffmpegBin: '/test/ffmpeg', spawnImpl,
    fetchImpl: async (_url, { body }) => { uploaded = body.get('file'); return { ok: true, json: async () => ({ text: 'voice text' }) } },
  })
  assert.deepEqual(await transcriber.transcribe({ path, name: 'voice.ogg', mime: 'audio/ogg; codecs=opus', duration: 20 }), { text: 'voice text' })
  assert.equal(command.bin, '/test/ffmpeg'); assert.equal(command.options.stdio, 'ignore')
  assert.equal(command.options.env.TEST_TRANSCRIPTION_CHILD_SECRET, undefined); assert.equal(command.options.env.TEST_OPERATIONAL_PAT, undefined)
  assert.equal(command.options.env.TELEGRAM_BOT_TOKEN, undefined)
  assert.ok(command.args.includes('-nostdin')); assert.equal(command.args[command.args.indexOf('-c:a') + 1], 'copy')
  assert.equal(command.args[command.args.indexOf('-t') + 1], '600')
  assert.equal(command.args[command.args.indexOf('-f') + 1], 'webm')
  assert.equal(uploaded.name, 'audio.webm'); assert.equal(uploaded.type, 'audio/webm')
  assert.equal(Buffer.from(await uploaded.arrayBuffer()).toString(), 'webm bytes')
  assert.equal(existsSync(temporaryDir), false)
})

test('unsupported, empty, oversized, and over-duration inputs fail before network access', async t => {
  const path = fixture(t); let requests = 0; let logs = []
  const transcriber = new OpenAITranscriber({ apiKey: 'key', fetchImpl: async () => { requests += 1 }, log: message => logs.push(message) })
  assert.equal(await transcriber.transcribe({ path, name: 'voice.flac', mime: 'audio/flac' }), null)
  assert.equal(await transcriber.transcribe({ path, name: 'voice.mp3', mime: 'audio/mpeg', duration: 601 }), null)
  const empty = fixture(t, 'empty.wav', '')
  assert.equal(await transcriber.transcribe({ path: empty, name: 'empty.wav', mime: 'audio/wav' }), null)
  const large = fixture(t, 'large.mp3'); truncateSync(large, (20 * 1024 * 1024) + 1)
  assert.equal(await transcriber.transcribe({ path: large, name: 'large.mp3', mime: 'audio/mpeg' }), null)
  assert.equal(requests, 0)
  assert.deepEqual(logs, ['transcription: unsupported_format', 'transcription: duration_limit', 'transcription: input_size_limit', 'transcription: input_size_limit'])
})

test('conversion failure and converted-size overflow fail softly and always clean up', async t => {
  const path = fixture(t, 'voice.ogg'); const tempDirs = []; const logs = []; let mode = 'fail'; let requests = 0
  const spawnImpl = (_bin, args) => {
    tempDirs.push(join(args.at(-1), '..'))
    if (mode === 'fail') { const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit('close', 1, null)); return child }
    return childThat(() => truncateSync(args.at(-1), 25_000_001))
  }
  const transcriber = new OpenAITranscriber({ apiKey: 'key', spawnImpl, fetchImpl: async () => { requests += 1 }, log: value => logs.push(value) })
  assert.equal(await transcriber.transcribe({ path, name: 'voice.ogg', mime: 'audio/ogg' }), null)
  mode = 'large'
  assert.equal(await transcriber.transcribe({ path, name: 'voice.opus', mime: 'audio/opus' }), null)
  assert.equal(requests, 0); assert.ok(tempDirs.every(dir => !existsSync(dir)))
  assert.deepEqual(logs, ['transcription: conversion_failed', 'transcription: converted_size_limit'])
})

test('API errors, invalid responses, and request timeouts are best-effort fallbacks', async t => {
  const path = fixture(t); const logs = []
  const options = { apiKey: 'key', log: value => logs.push(value), timeoutMs: 10 }
  const apiError = new OpenAITranscriber({ ...options, fetchImpl: async () => ({ ok: false, json: async () => assert.fail('error body must not be read') }) })
  assert.equal(await apiError.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg' }), null)
  const invalid = new OpenAITranscriber({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ text: '   ' }) }) })
  assert.equal(await invalid.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg' }), null)
  const timeout = new OpenAITranscriber({ ...options, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  assert.equal(await timeout.transcribe({ path, name: 'clip.mp3', mime: 'audio/mpeg' }), null)
  assert.deepEqual(logs, ['transcription: api_error', 'transcription: invalid_response', 'transcription: timeout'])
})

test('cancellation kills and waits for ffmpeg before returning, then cleans up', async t => {
  const path = fixture(t, 'voice.ogg'); const controller = new AbortController()
  let killedWith; let closed = false; let temporaryDir
  const spawnImpl = (_bin, args) => {
    temporaryDir = join(args.at(-1), '..')
    const child = new EventEmitter()
    child.kill = signal => { killedWith = signal; setTimeout(() => { closed = true; child.emit('close', null, signal) }, 10); return true }
    queueMicrotask(() => controller.abort())
    return child
  }
  const logs = []
  const transcriber = new OpenAITranscriber({ apiKey: 'key', spawnImpl, fetchImpl: async () => assert.fail('must not fetch'), log: value => logs.push(value), timeoutMs: 100 })
  assert.equal(await transcriber.transcribe({ path, name: 'voice.ogg', mime: 'audio/ogg', signal: controller.signal }), null)
  assert.equal(killedWith, 'SIGKILL'); assert.equal(closed, true)
  assert.equal(existsSync(temporaryDir), false); assert.deepEqual(logs, ['transcription: cancelled'])
})

test('categorical logs never include keys, transcripts, response bodies, or filenames', async t => {
  const marker = 'DO_NOT_LOG'; const path = fixture(t, `${marker}.mp3`); const logs = []
  const transcriber = new OpenAITranscriber({
    apiKey: `sk-${marker}`, log: value => logs.push(value),
    fetchImpl: async () => { throw new Error(`${marker} transcript and response body`) },
  })
  assert.equal(await transcriber.transcribe({ path, name: `${marker}.mp3`, mime: 'audio/mpeg' }), null)
  assert.deepEqual(logs, ['transcription: request_failed']); assert.doesNotMatch(logs.join('\n'), /DO_NOT_LOG|sk-DO_NOT_LOG/)
})
