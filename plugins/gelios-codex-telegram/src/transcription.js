import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

export const TRANSCRIPT_PREFIX = '[Voice message, auto-transcribed — may contain transcription errors]'
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_OUTPUT_BYTES = 25_000_000
const MAX_DURATION_SECONDS = 10 * 60
const DIRECT_EXTENSIONS = new Set(['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm'])
const OGG_EXTENSIONS = new Set(['.ogg', '.oga', '.opus'])
const MIME_EXTENSIONS = new Map([
  ['audio/mpeg', '.mp3'], ['audio/mp4', '.mp4'], ['video/mp4', '.mp4'],
  ['audio/x-m4a', '.m4a'], ['audio/wav', '.wav'], ['audio/x-wav', '.wav'],
  ['audio/wave', '.wav'], ['audio/webm', '.webm'], ['video/webm', '.webm'],
])

function categoryError(category) { return Object.assign(new Error(category), { category }) }
function safeName(name, fallback) {
  const value = basename(String(name || fallback)).replace(/[\0-\x1f\x7f]/g, '_')
  return value && value !== '.' && value !== '..' ? value : fallback
}
function formatFor(name, mime) {
  const extension = extname(String(name || '')).toLowerCase()
  const type = String(mime || '').split(';', 1)[0].trim().toLowerCase()
  if (OGG_EXTENSIONS.has(extension) || type === 'audio/ogg' || type === 'audio/opus') return { remux: true, extension: '.webm' }
  if (DIRECT_EXTENSIONS.has(extension)) return { remux: false, extension }
  const mapped = MIME_EXTENSIONS.get(type)
  return mapped ? { remux: false, extension: mapped } : null
}
function waitForChild(child, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stopped = null
    const stop = category => { stopped ||= category; try { child.kill('SIGKILL') } catch {} }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('conversion_timeout'), timeoutMs)
    const finish = error => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', () => finish(categoryError(stopped || 'conversion_failed')))
    child.once('close', code => finish(code === 0 && !stopped ? null : categoryError(stopped || 'conversion_failed')))
    if (signal?.aborted) abort()
  })
}

export class OpenAITranscriber {
  constructor({ apiKey, fetchImpl = globalThis.fetch, spawnImpl = spawn, ffmpegBin = 'ffmpeg', ffmpegEnv, log = () => {}, timeoutMs = 60_000 }) {
    ffmpegEnv ||= Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP']
      .filter(name => process.env[name] !== undefined && process.env[name] !== apiKey).map(name => [name, process.env[name]]))
    Object.assign(this, { apiKey, fetchImpl, spawnImpl, ffmpegBin, ffmpegEnv, log, timeoutMs })
  }
  fail(category) { try { this.log(`transcription: ${category}`) } catch {} return null }
  async remux(input, signal) {
    const dir = await mkdtemp(join(tmpdir(), 'gelios-transcription-'))
    const output = join(dir, 'audio.webm')
    try {
      await writeFile(output, '', { mode: 0o600, flag: 'wx' })
      const args = ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', '-t', String(MAX_DURATION_SECONDS), '-c:a', 'copy', '-fs', String(MAX_OUTPUT_BYTES), '-f', 'webm', output]
      await waitForChild(this.spawnImpl(this.ffmpegBin, args, { stdio: 'ignore', env: this.ffmpegEnv }), signal, this.timeoutMs)
      const info = await stat(output)
      if (!info.size || info.size > MAX_OUTPUT_BYTES) throw categoryError('converted_size_limit')
      return { bytes: await readFile(output), name: 'audio.webm', type: 'audio/webm' }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  async transcribe({ path, name, mime, duration, signal }) {
    if (!this.apiKey) return this.fail('not_configured')
    if (signal?.aborted) return this.fail('cancelled')
    const format = formatFor(name, mime)
    if (!format) return this.fail('unsupported_format')
    if (Number.isFinite(Number(duration)) && Number(duration) > MAX_DURATION_SECONDS) return this.fail('duration_limit')
    try {
      const info = await stat(path)
      if (!info.isFile() || !info.size || info.size > MAX_INPUT_BYTES) return this.fail('input_size_limit')
      const directName = DIRECT_EXTENSIONS.has(extname(String(name || '')).toLowerCase()) ? safeName(name, `audio${format.extension}`) : `audio${format.extension}`
      const file = format.remux ? await this.remux(path, signal) : { bytes: await readFile(path), name: directName, type: mime || 'application/octet-stream' }
      if (signal?.aborted) return this.fail('cancelled')
      const form = new FormData(); form.set('model', 'gpt-transcribe'); form.set('file', new Blob([file.bytes], { type: file.type }), file.name)
      const controller = new AbortController()
      const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, this.timeoutMs)
      try {
        const response = await this.fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: controller.signal })
        if (!response.ok) return this.fail('api_error')
        const data = await response.json().catch(() => null)
        const text = typeof data?.text === 'string' ? data.text.trim() : ''
        return text ? { text } : this.fail('invalid_response')
      } catch { return this.fail(signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'request_failed') }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    } catch (error) { return this.fail(error?.category || (signal?.aborted ? 'cancelled' : 'processing_failed')) }
  }
}
