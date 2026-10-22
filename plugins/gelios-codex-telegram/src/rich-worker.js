// Computes richParts off the bridge's thread, so only this worker compiles the
// parser. See richPartsAsync in rich.js.
import { parentPort } from 'node:worker_threads'
import { richParts } from './rich-parse.js'

parentPort.on('message', ({ id, text, limits }) => {
  try {
    parentPort.postMessage({ id, parts: richParts(text, limits) })
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) })
  }
})

parentPort.postMessage({ loaded: true })
