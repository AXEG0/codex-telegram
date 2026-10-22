import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { mkdtempSync } from './fixtures.js'
import {
  RICH_PART_BLOCKS, RICH_PART_BYTES, editRichParsed, plainFallback, richEditParse, richPartsAsync, richText, sendRich,
} from '../src/rich.js'
import { richMarkdown, richParts } from '../src/rich-parse.js'
import { TelegramError } from '../src/telegram.js'

// The cases of AXEG0/claude-telegram's rich.test.ts, whose expected outputs were
// sent to Telegram and read back from its parse: no formula, no visible
// backslash, and the text as written.
const S = '$HOME/$USER'
const E = '\\$HOME/\\$USER'
const silent = () => {}

test('a $ in text is escaped, as "$HOME/$USER" would open a formula', () => {
  assert.equal(richMarkdown(`path ${S} ok`), 'path \\$HOME/\\$USER ok')
  assert.equal(richMarkdown(`## Cost ${S}`), '## Cost \\$HOME/\\$USER')
  assert.equal(richMarkdown(`| a | b |\n|---|---|\n| ${S} | \`$x\` |`), '| a | b |\n|---|---|\n| \\$HOME/\\$USER | `$x` |')
})

test('code keeps its $ wherever it sits', () => {
  assert.equal(richMarkdown(`Example:\n\n    echo ${S}\n\nafter ${S}`), 'Example:\n\n    echo $HOME/$USER\n\nafter \\$HOME/\\$USER')
  assert.equal(richMarkdown(`- a\n  - b\n    \`\`\`bash\n    echo ${S}\n    \`\`\`\n- after ${S}`),
    '- a\n  - b\n    ```bash\n    echo $HOME/$USER\n    ```\n- after \\$HOME/\\$USER')
  assert.equal(richMarkdown(`> \`\`\`bash\n> echo ${S}\n> \`\`\`\n> and ${S}`), '> ```bash\n> echo $HOME/$USER\n> ```\n> and \\$HOME/\\$USER')
  assert.equal(richMarkdown(`run \`echo\n${S}\` ok`), 'run `echo\n$HOME/$USER` ok')
  assert.equal(richMarkdown(`<pre>echo ${S}</pre>`), '<pre>echo $HOME/$USER</pre>')
})

test('URLs keep their $, except bare ones, which Telegram reads as text', () => {
  assert.equal(richMarkdown('<https://example.com/?q=$1>'), '<https://example.com/?q=$1>')
  assert.equal(richMarkdown('[pay $1](https://example.com/?q=$1)'), '[pay \\$1](https://example.com/?q=$1)')
  assert.equal(richMarkdown('see https://example.com/?q=$1 now'), 'see https://example.com/?q=\\$1 now')
})

test('math and existing escapes stay as written', () => {
  assert.equal(richMarkdown(`<tg-math>x^2</tg-math> costs ${S}`), '<tg-math>x^2</tg-math> costs \\$HOME/\\$USER')
  assert.equal(richMarkdown('```math\nE = $x$\n```'), '```math\nE = $x$\n```')
  assert.equal(richMarkdown('already \\$5 and \\\\$6'), 'already \\$5 and \\\\\\$6')
})

test('inside <details> it is Markdown again, code included', () => {
  assert.equal(richMarkdown(`<details><summary>Cost ${S}</summary>\nItem ${S}\n\`\`\`\necho ${S}\n\`\`\`\n</details>`),
    '<details><summary>Cost \\$HOME/\\$USER</summary>\nItem \\$HOME/\\$USER\n```\necho $HOME/$USER\n```\n</details>')
})

test('<details> in any layout: summary on its own line, in a list, around code, with text after', () => {
  assert.equal(richMarkdown(`<details>\n<summary>Cost ${S}</summary>\nItem ${S}\n</details>`),
    `<details>\n<summary>Cost ${E}</summary>\nItem ${E}\n</details>`)
  assert.equal(richMarkdown(`- a\n  - b\n    <details><summary>S</summary>\n    body ${S}\n    </details>`),
    `- a\n  - b\n    <details><summary>S</summary>\n    body ${E}\n    </details>`)
  assert.equal(richMarkdown(`<details><summary>x</summary>\n\`\`\`bash\necho $a\n\necho $b\n\`\`\`\n</details>\nafter ${S}`),
    `<details><summary>x</summary>\n\`\`\`bash\necho $a\n\necho $b\n\`\`\`\n</details>\nafter ${E}`)
  assert.equal(richMarkdown(`<details><summary>A</summary>\n<details><summary>B ${S}</summary>\nC Vec<String>\n</details>\n</details>`),
    `<details><summary>A</summary>\n<details><summary>B ${E}</summary>\nC Vec&lt;String>\n</details>\n</details>`)
  assert.equal(richMarkdown('```html\n<details><summary>$x</summary>\n```'), '```html\n<details><summary>$x</summary>\n```')
  assert.equal(richMarkdown('<pre>\n<details>\n$x\n</pre>'), '<pre>\n<details>\n$x\n</pre>')
})

test('a tag that ends its line ends the block, as in Telegram: an indented line after it is code', () => {
  for (const md of [
    '<details><summary>Out</summary>\n    $ ls $HOME/$USER\n</details>',
    '<details>\n    $ ls $HOME/$USER\n</details>',
    '<details><summary>A</summary>\nbody\n</details>\n    $ ls $HOME/$USER',
  ]) assert.equal(richMarkdown(md), md)
})

test('a tag Telegram would drop becomes text; HTML it renders or drops stays', () => {
  assert.equal(richMarkdown('Vec<String>, Promise<void> and </T>; <kbd>Ctrl</kbd> <b>b</b>'),
    'Vec&lt;String>, Promise&lt;void> and &lt;/T>; <kbd>Ctrl</kbd> <b>b</b>')
  assert.equal(richMarkdown('`Vec<String>`'), '`Vec<String>`')
})

const small = { bytes: 100, blocks: 400 }
const plains = parts => parts.map(part => part.plain)

test('one part when it fits, with the text as written for a plain fallback', () => {
  assert.deepEqual(richParts('costs $5'), [{ rich: 'costs \\$5', plain: 'costs $5' }])
  assert.deepEqual(richParts('\n\n   ```\n   $x\n   ```\n'), [{ rich: '   ```\n   $x\n   ```', plain: '   ```\n   $x\n   ```' }])
})

test('cuts between top-level blocks, counting UTF-8 bytes', () => {
  const para = 'ж'.repeat(30)
  const parts = richParts([para, para, para].join('\n\n'), small)
  assert.deepEqual(plains(parts), [para, para, para])
  for (const part of parts) assert.ok(Buffer.byteLength(part.rich) <= 100)
})

test('cuts by block count', () => {
  assert.deepEqual(plains(richParts(['a', 'b', 'c', 'd', 'e'].join('\n\n'), { bytes: 1000, blocks: 2 })), ['a\n\nb', 'c\n\nd', 'e'])
})

test('a long Cyrillic reply splits within the 30000 UTF-8 bytes Telegram keeps whole, though its characters fit', () => {
  assert.equal(RICH_PART_BYTES, 30_000)
  const paragraphs = Array.from({ length: 20 }, (_, index) => `${index} ${'ж'.repeat(1000)}`)
  const text = paragraphs.join('\n\n')
  assert.ok(text.length < 32_768 && Buffer.byteLength(text) > RICH_PART_BYTES)
  const parts = richParts(text)
  assert.equal(parts.length, 2)
  for (const part of parts) assert.ok(Buffer.byteLength(part.rich) <= RICH_PART_BYTES)
  assert.equal(plains(parts).join('\n\n'), text)
})

test('a reply of more than 400 blocks splits at the 400th', () => {
  assert.equal(RICH_PART_BLOCKS, 400)
  const blocks = Array.from({ length: 450 }, (_, index) => `p${index}`)
  const parts = richParts(blocks.join('\n\n'))
  assert.deepEqual(plains(parts), [blocks.slice(0, 400).join('\n\n'), blocks.slice(400).join('\n\n')])
})

test('a code block too big alone is closed and reopened around each cut', () => {
  const body = Array.from({ length: 12 }, (_, index) => `echo $${index}`)
  const parts = richParts('intro\n\n```bash\n' + body.join('\n') + '\n```', small)
  assert.equal(parts[0].plain, 'intro')
  const code = parts.slice(1)
  assert.ok(code.length > 1)
  for (const part of code) {
    assert.ok(part.rich.startsWith('```bash\n'))
    assert.ok(part.rich.endsWith('\n```'))
    assert.equal(part.rich.includes('\\$'), false)
    assert.ok(Buffer.byteLength(part.rich) <= 100)
  }
  assert.deepEqual(code.flatMap(part => part.rich.split('\n').slice(1, -1)), body)
})

test('a table too big alone repeats its header', () => {
  const rows = Array.from({ length: 10 }, (_, index) => `| ${index} | $${index} |`)
  const parts = richParts(['| n | cost |', '|---|---|', ...rows].join('\n'), small)
  assert.ok(parts.length > 1)
  for (const part of parts) assert.ok(part.plain.startsWith('| n | cost |\n|---|---|\n'))
  assert.deepEqual(parts.flatMap(part => part.plain.split('\n').slice(2)), rows)
})

test('a <details> inside a list item does not cut the list', () => {
  const list = '- a\n  <details><summary>S</summary>\n  body\n  </details>\n- b'
  assert.deepEqual(plains(richParts(list + '\n\nafter', { bytes: 1000, blocks: 1 })), [list, 'after'])
  // Too big for one part, the list is cut between its items, not at the tag.
  assert.deepEqual(plains(richParts(list + '\n\nafter', { bytes: 58, blocks: 400 })),
    ['- a\n  <details><summary>S</summary>\n  body\n  </details>', '- b', 'after'])
})

test('a <details> in code, raw <pre> or prose opens no section', () => {
  const one = { bytes: 1000, blocks: 1 }
  assert.deepEqual(plains(richParts('<details><summary>Ex</summary>\n```html\n<details>\n```\n</details>\n\na\n\nb', one)),
    ['<details><summary>Ex</summary>\n```html\n<details>\n```\n</details>', 'a', 'b'])
  assert.deepEqual(plains(richParts('<pre>\n<details>\n</pre>\n\na\n\nb', one)), ['<pre>\n<details>\n</pre>', 'a', 'b'])
  assert.deepEqual(plains(richParts('Use <details> for a fold.\n\na\n\nb', one)), ['Use <details> for a fold.', 'a', 'b'])
  assert.deepEqual(plains(richParts('```\n<details>\n```\n\na\n\nb', one)), ['```\n<details>\n```', 'a', 'b'])
})

test('a <details> section is never cut between its tags', () => {
  const md = ['before', '<details><summary>More</summary>', 'one', 'two', '</details>', 'after'].join('\n\n')
  assert.deepEqual(plains(richParts(md, { bytes: 1000, blocks: 2 })),
    ['before', '<details><summary>More</summary>\n\none\n\ntwo\n\n</details>', 'after'])
})

test('text of Unicode spaces is still sent', () => {
  assert.deepEqual(plains(richParts('\u3000')), ['\u3000'])
  assert.deepEqual(plains(richParts('a\n\n\u00a0\n\nb')), ['a\n\n\u00a0\n\nb'])
})

test('the parts cover the text once: a bare CR between blocks sends nothing twice', () => {
  const md = 'A'.repeat(60) + '\r\r' + 'B'.repeat(60) + '\r\r' + 'C'.repeat(60)
  assert.deepEqual(plains(richParts(md, small)), ['A'.repeat(60), 'B'.repeat(60), 'C'.repeat(60)])
})

test('a list too big alone is cut between items; an item too big alone goes out plain', () => {
  const items = Array.from({ length: 6 }, (_, index) => `- item ${index} $${index} ${'x'.repeat(20)}`)
  const big = '- big\n  ```\n' + '  line $x\n'.repeat(12) + '  ```'
  const parts = richParts([...items.slice(0, 3), big, ...items.slice(3)].join('\n'), small)
  assert.equal(plains(parts).join('\n'), [...items.slice(0, 3), big, ...items.slice(3)].join('\n'))
  for (const part of parts) {
    if (part.rich === undefined) assert.equal(part.plain, big)
    else {
      assert.ok(part.rich.startsWith('- item'))
      assert.ok(Buffer.byteLength(part.rich) <= 100)
    }
  }
})

test('a quote too big alone is cut between its blocks, each part still quoted', () => {
  const blocks = Array.from({ length: 6 }, (_, index) => `> quote ${index} $${index} ${'q'.repeat(20)}`)
  const parts = richParts(blocks.join('\n>\n'), small)
  assert.ok(parts.length > 1)
  for (const part of parts) assert.ok(part.rich.startsWith('> quote'))
})

test('a code line too long alone is cut inside its fence, never inside a surrogate pair', () => {
  const parts = richParts('```\n' + '😀'.repeat(60) + '\n```', small)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part.rich) <= 100)
    assert.match(part.rich, /^```\n\p{Extended_Pictographic}+\n```$/u)
  }
})

test('a lone surrogate is counted as the 3 bytes it goes out as', () => {
  for (const part of richParts('```\n' + '\udc00'.repeat(60) + '\n```', small)) assert.ok(Buffer.byteLength(part.rich) <= 100)
})

test('an unclosed fence keeps its last line', () => {
  const parts = richParts('```\n' + 'code $x\n'.repeat(20) + '```js', small)
  assert.ok(parts.at(-1).plain.endsWith('```js\n```'))
})

test('a paragraph too big alone goes out plain, as written', () => {
  const line = 'word $x `c$` '.repeat(20)
  assert.deepEqual(richParts(line, small), [{ plain: line.trimEnd() }])
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index} $x \`c\``).join('\n')
  assert.deepEqual(richParts(lines, small), [{ plain: lines }])
})

test('the worker splits as richParts does', async () => {
  assert.deepEqual(await richPartsAsync('costs $5', undefined, { log: silent }), richParts('costs $5'))
})

test('text the parser has not split in time goes out plain, and the next text splits again', { timeout: 30_000 }, async () => {
  const deep = Array.from({ length: 400 }, (_, index) => ' '.repeat(index * 2) + '- x').join('\n')
  const lines = []
  const log = line => lines.push(line)
  const started = Date.now()
  const [stuck, behind] = await Promise.all([richPartsAsync(deep, undefined, { ms: 300, log }), richPartsAsync('queued $x', undefined, { log })])
  assert.deepEqual(stuck, [{ plain: deep }])
  assert.deepEqual(behind, [{ plain: 'queued $x' }])
  assert.ok(Date.now() - started < 2000)
  assert.ok(lines.some(line => /rich parse failed, sending plain: no result in 300 ms/.test(line)))
  assert.deepEqual(await richPartsAsync('next $x', undefined, { log }), richParts('next $x'))
})

// Every module a file statically imports or re-exports, a bare import included,
// followed through relative paths.
function staticImports(entry, seen = new Set()) {
  if (seen.has(entry)) return seen
  seen.add(entry)
  for (const match of readFileSync(entry, 'utf8').matchAll(/^\s*(?:import|export)\s(?:[^'";()=]*?\sfrom\s*)?['"](\.[^'"]+)['"]/gm)) {
    staticImports(resolve(dirname(entry), match[1]), seen)
  }
  return seen
}

test('the bridge loads no parser on its own thread: only the worker imports it', () => {
  const bridge = staticImports(new URL('../scripts/bridge.js', import.meta.url).pathname)
  assert.ok([...bridge].some(path => path.endsWith('/src/rich.js')))
  assert.deepEqual([...bridge].filter(path => /\/src\/(rich-parse|markdown-parser)\.js$/.test(path)), [])
  const worker = staticImports(new URL('../src/rich-worker.js', import.meta.url).pathname)
  assert.ok([...worker].some(path => path.endsWith('/src/markdown-parser.js')))
})

test('without a worker file the parts are computed on the calling thread, as the worker would', () => {
  const root = mkdtempSync(join(tmpdir(), 'rich-no-worker-'))
  for (const name of ['rich.js', 'rich-parse.js', 'markdown-parser.js']) copyFileSync(new URL(`../src/${name}`, import.meta.url), join(root, name))
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'))
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { richPartsAsync } = await import(${JSON.stringify(join(root, 'rich.js'))})
    const lines = []
    const parts = await richPartsAsync('costs $5', undefined, { log: line => lines.push(line) })
    console.log(JSON.stringify({ parts, lines }))`], { encoding: 'utf8' })
  const { parts, lines } = JSON.parse(output)
  assert.deepEqual(parts, richParts('costs $5'))
  assert.ok(lines.some(line => line.startsWith('telegram: rich worker did not load, parsing in the bridge')))
})

test('content Telegram rejects or a server without rich messages falls back to plain, nothing else does', () => {
  assert.equal(plainFallback(new TelegramError('Bad Request: RICH_MESSAGE_MARKDOWN_INVALID', 400)), true)
  assert.equal(plainFallback(new TelegramError('Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY', 400)), true)
  assert.equal(plainFallback(new TelegramError('Not Found: method not found', 404)), true)
  assert.equal(plainFallback(new TelegramError('Bad Request: message is not modified: specified new message content and reply markup are exactly the same', 400)), false)
  assert.equal(plainFallback(new TelegramError('Too Many Requests: retry after 5', 429)), false)
  assert.equal(plainFallback(new Error('fetch failed')), false)
})

function fakeSend(fail = () => undefined) {
  const calls = []
  let id = 100
  const send = async (method, params) => {
    calls.push({ method, params })
    const error = fail(method, calls.filter(call => call.method === method).length)
    if (error) throw error
    return { message_id: ++id }
  }
  return { send, calls }
}
const progress = () => ({ ids: [], rich: [], done: 0, total: 0 })
const rejected = () => new TelegramError('Bad Request: RICH_MESSAGE_MARKDOWN_INVALID', 400)

test('sendRich sends escaped Markdown as a rich message, replying on the first message', async () => {
  const f = fakeSend()
  const p = progress()
  await sendRich({ send: f.send, chatId: '555', text: 'costs $5', replyTo: n => (n === 0 ? 7 : undefined), plainChunks: t => [t], progress: p, log: silent })
  assert.deepEqual(p, { ids: [101], rich: [101], done: 1, total: 1 })
  assert.deepEqual(f.calls, [{ method: 'sendRichMessage', params: {
    chat_id: '555', rich_message: { markdown: 'costs \\$5' }, reply_parameters: { message_id: 7, allow_sending_without_reply: true },
  } }])
})

test('sendRich sends a part Telegram rejects plain, unescaped, cut by plainChunks, each threaded as asked', async () => {
  const f = fakeSend(method => (method === 'sendRichMessage' ? rejected() : undefined))
  const p = progress()
  const lines = []
  await sendRich({ send: f.send, chatId: '555', text: 'costs $5', replyTo: () => 7, plainChunks: t => [t.slice(0, 4), t.slice(4)], progress: p,
    log: line => lines.push(line) })
  assert.deepEqual(p, { ids: [101, 102], rich: [], done: 1, total: 1 })
  assert.deepEqual(f.calls.map(call => [call.method, call.params.text, call.params.reply_parameters]), [
    ['sendRichMessage', undefined, { message_id: 7, allow_sending_without_reply: true }],
    ['sendMessage', 'cost', { message_id: 7, allow_sending_without_reply: true }],
    ['sendMessage', 's $5', { message_id: 7, allow_sending_without_reply: true }],
  ])
  assert.deepEqual(lines, ['telegram: rich message rejected, sending plain: Bad Request: RICH_MESSAGE_MARKDOWN_INVALID'])
})

test('sendRich sends a part only plain text keeps whole plain without a rich try', async () => {
  const f = fakeSend()
  const p = progress()
  const text = 'word $x '.repeat(5000)
  await sendRich({ send: f.send, chatId: '555', text, replyTo: () => undefined, plainChunks: t => [t.slice(0, 4096), t.slice(4096)], progress: p, log: silent })
  assert.deepEqual(f.calls.map(call => call.method), ['sendMessage', 'sendMessage'])
  assert.deepEqual(p, { ids: [101, 102], rich: [], done: 1, total: 1 })
})

test('sendRich leaves what was sent in progress after a failure part way, and rethrows it', async () => {
  const tooMany = new TelegramError('Too Many Requests: retry after 5', 429)
  const f = fakeSend((method, n) => (method === 'sendRichMessage' && n === 2 ? tooMany : undefined))
  const p = progress()
  const text = 'a'.repeat(20_000) + '\n\n' + 'b'.repeat(20_000)
  await assert.rejects(sendRich({ send: f.send, chatId: '555', text, replyTo: () => undefined, plainChunks: t => [t], progress: p, log: silent }),
    error => error === tooMany)
  assert.deepEqual(p, { ids: [101], rich: [101], done: 1, total: 2 })
  assert.deepEqual(f.calls.map(call => call.method), ['sendRichMessage', 'sendRichMessage'])
})

test('sendRich reports each message sent with the text written for it: the part as written, or each plain chunk', async () => {
  const rich = fakeSend()
  const seen = []
  await sendRich({ send: rich.send, chatId: '7', text: 'costs $5', replyTo: () => undefined, plainChunks: t => [t], progress: progress(),
    sent: (id, words) => seen.push([id, words]), log: silent })
  assert.deepEqual(seen, [[101, 'costs $5']])
  const plain = fakeSend(method => (method === 'sendRichMessage' ? rejected() : undefined))
  seen.length = 0
  await sendRich({ send: plain.send, chatId: '7', text: 'costs $5', replyTo: () => undefined, plainChunks: t => [t.slice(0, 4), t.slice(4)],
    progress: progress(), sent: (id, words) => seen.push([id, words]), log: silent })
  assert.deepEqual(seen, [[101, 'cost'], [102, 's $5']])
})

const editRich = async ({ send, text }) => editRichParsed({ send, chatId: '555', messageId: 9, text, rich: await richEditParse(text, silent), log: silent })

test('an edit goes rich, or plain and whole when Telegram rejects it', async () => {
  const ok = fakeSend()
  await editRich({ send: ok.send, text: '$1' })
  assert.deepEqual(ok.calls[0].params, { chat_id: '555', message_id: 9, rich_message: { markdown: '\\$1' } })
  const long = 'x'.repeat(5000)
  const bad = fakeSend(method => (method === 'editMessageText' && bad.calls.length === 1 ? rejected() : undefined))
  await editRich({ send: bad.send, text: long })
  assert.deepEqual(bad.calls[1].params, { chat_id: '555', message_id: 9, text: long })
})

test('an unchanged message stays rich: the error goes back, with no plain edit', async () => {
  const same = new TelegramError('Bad Request: message is not modified', 400)
  const f = fakeSend(() => same)
  await assert.rejects(editRich({ send: f.send, text: 'x' }), error => error === same)
  assert.equal(f.calls.length, 1)
})

test('many short blocks still edit as one rich message', async () => {
  const f = fakeSend()
  await editRich({ send: f.send, text: Array.from({ length: 450 }, (_, index) => `p${index}`).join('\n\n') })
  assert.deepEqual(f.calls.map(call => Object.keys(call.params)), [['chat_id', 'message_id', 'rich_message']])
})

test('text for more than one rich message is refused before any edit', async () => {
  const f = fakeSend()
  await assert.rejects(editRich({ send: f.send, text: 'a'.repeat(20_000) + '\n\n' + 'b'.repeat(20_000) }), /too long/)
  assert.deepEqual(f.calls, [])
})

test('the text of a rich message is read block by block, for a reply to one', () => {
  assert.equal(richText({ rich_message: { blocks: [
    { type: 'heading', text: 'Build' },
    { type: 'table', cells: [[{ text: 'OS' }, { text: [{ text: 'Node' }] }], [{ text: 'Linux' }, { text: '22' }]] },
    { type: 'list', items: [{ blocks: [{ text: 'done' }] }] },
  ] } }), 'Build OS Node Linux 22 done')
  assert.equal(richText({ text: 'plain' }), undefined)
})
