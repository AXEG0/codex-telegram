// The tests' stand-ins for Telegram keep texts and captions by the rules here: the fixture's fakes behind TelegramChannel
// (standInApi, test/bot-files.test.js) and the fake Telegram server the bridge tests start (test/bridge.test.js) read them,
// and test/live-check.js runs every one of them against Telegram itself.
import { CAPTION_MAX, captionLength, captionText } from '../../src/bot-files.js'

// Telegram's refusals of an edit made through the wrong call, as Telegram answered them when read live on
// 2026-11-06: editMessageText on a file, and editMessageCaption on a text message, which this plugin never makes.
export const NO_TEXT = 'Bad Request: there is no text in the message to edit'
export const NO_CAPTION = 'Bad Request: there is no caption in the message to edit'
// The stand-ins keep and count a caption by the plugin's own rule (src/bot-files.js), so a change to it reaches them too:
// Telegram answers a file send with the caption it keeps, none when nothing is left, and refused a send whose kept
// caption was over 1024 with LONG_CAPTION (read live on a send).
export const captionKept = caption => caption === undefined ? '' : captionText(caption)
export const LONG_CAPTION = 'Bad Request: message caption is too long'
export const tooLong = captions => captions.some(caption => captionLength(captionKept(caption)) > CAPTION_MAX)

export class StandInError extends Error {
  constructor(description, code) { super(description); this.code = code }
}

// The fixture's fakes for TelegramApi's call, multipart and multipartFiles: each call gets the next message ID from firstId,
// and each is recorded, a file send's once its beforeSend has run. A file send is answered with the file and its caption as
// Telegram keeps one (captionKept), or refused with LONG_CAPTION; dropCaption answers a captioned file send without its
// caption. Of the messages it sent, it refuses a text edit of a file with NO_TEXT and a caption edit of a text with
// NO_CAPTION, and answers a caption edit of a file with the file and the caption it keeps, as the bridge tests' server does;
// an ID it never sent it accepts, as before. Refusals are thrown as `error`, TelegramError's shape by default.
export function standInApi({ firstId = 10, dropCaption = false, record = () => {}, error = (description, code) => new StandInError(description, code) } = {}) {
  let nextId = firstId
  // What this fake sent, by message ID.
  const kinds = new Map()
  const file = (field, id) => ({ [field]: field === 'photo' ? [{ file_id: `file-${id}` }] : { file_id: `file-${id}` } })
  const fileSent = (field, caption) => {
    const id = nextId++, kept = captionKept(caption); kinds.set(id, { kind: 'file', field })
    return { message_id: id, ...file(field, id), ...(kept && !dropCaption ? { caption: kept } : {}) }
  }
  return {
    call: async (method, fields) => {
      record({ method, fields })
      const sent = kinds.get(Number(fields?.message_id))
      if (method === 'editMessageText' && sent?.kind === 'file') throw error(NO_TEXT, 400)
      if (method === 'editMessageCaption' && sent?.kind === 'text') throw error(NO_CAPTION, 400)
      const id = nextId++; if (['sendMessage', 'sendRichMessage'].includes(method)) kinds.set(id, { kind: 'text' })
      if (method === 'editMessageCaption' && sent?.kind === 'file') {
        const kept = captionKept(fields.caption)
        return { message_id: Number(fields.message_id), ...file(sent.field, Number(fields.message_id)), ...(kept ? { caption: kept } : {}) }
      }
      return { message_id: id }
    },
    multipart: async (method, fields, fieldName, upload, options) => {
      options?.beforeSend?.(); record({ method, fields, files: [{ fieldName, file: upload }] })
      if (tooLong([fields.caption])) throw error(LONG_CAPTION, 400)
      return fileSent(fieldName, fields.caption)
    },
    multipartFiles: async (method, fields, files, options) => {
      options?.beforeSend?.(); record({ method, fields, files })
      if (tooLong(fields.media.map(item => item.caption))) throw error(LONG_CAPTION, 400)
      return fields.media.map(item => fileSent(item.type, item.caption))
    },
  }
}
