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
import { parseMarkdown } from '../src/markdown-parser.js'
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

// The block tree GFM reads: types and leaf text, no positions, no spread.
const tree = md => {
  const shape = n =>
    'value' in n ? [n.type, n.value] : [n.type, ...(n.children ?? []).map(shape)]
  return shape(parseMarkdown(md))
}

const q = n => '> '.repeat(n)
const cols = (n, cell = ' c |') => '|' + cell.repeat(n)
const delim = n => '|' + '---|'.repeat(n)

// [text, the line inserted] for each shape the rule fires on.
const FIRES = [
  ['**The real risks**\n| Risk | Impact |\n|---|---|\n| a | b |', '\n'],
  ['> para\n> | a | b |\n> |---|---|', '\n>'],
  ['> > para\n> > | a | b |\n> > |---|---|', '\n> >'],
  ['> > > para\n> > > | a | b |\n> > > |---|---|', '\n> > >'],
  ['- a\n  | x | y |\n  |---|---|\n  | 1 | 2 |\n- b\n- c', '\n'],
  ['* a\n  | x | y |\n  |---|---|', '\n'],
  ['+ a\n  | x | y |\n  |---|---|', '\n'],
  ['1. a\n   | x | y |\n   |---|---|', '\n'],
  ['1) a\n   | x | y |\n   |---|---|', '\n'],
  ['- [ ] a\n  | x | y |\n  |---|---|', '\n'],
  ['- a\n  - b\n    | x | y |\n    |---|---|', '\n'],
  ['> - a\n>   | x | y |\n>   |---|---|', '\n>'],
  ['- > a\n  > | x | y |\n  > |---|---|', '\n  >'],
  ['line one\nline two\n| a | b |\n|---|---|', '\n'],
  ['> para\nlazy\n> | a | b |\n> |---|---|', '\n>'],
  ['para\n | a | b |\n |---|---|', '\n'],
  ['para\n   | a | b |\n   |---|---|', '\n'],
  ['para\na | b\n--|--', '\n'],
  ['para\n1234567890. a | b\n--|--', '\n'],
  ['para\n**Risk** | Impact\n--|--', '\n'],
  ['para\n*a* | b\n--|--', '\n'],
  ['para\n-x | y\n--|--', '\n'],
  ['para\n+1 | y\n--|--', '\n'],
  ['para\n3.5 | x\n--|--', '\n'],
  ['para\n. a | b\n--|--', '\n'],
  ['para\n) a | b\n--|--', '\n'],
  ['para\n3)x | y\n--|--', '\n'],
  ['para\n*\u00a0a | b\n--|--', '\n'],
  ['para\n| a | b |\n|:--|--:|', '\n'],
  ['para  \n| a | b |\n|---|---|', '\n'],
  ['para\t\n| a | b |\n|---|---|', '\n'],
  ['Intro\r\n| Risk | Impact |\r\n|---|---|\r\n| a | b |', '\r\n'],
  ['Intro\r\n| Risk | Impact |\n|---|---|\n| a | b |', '\r\n'],
  ['> para\r\n> | a | b |\r\n> |---|---|', '\r\n>'],
  ['- a\r\n  | x | y |\r\n  |---|---|', '\r\n'],
  ['para\n| a | b |\n|---|---|\r\n', '\n'],
  ['>para\n>| a | b |\n>|---|---|', '\n>'],
  ['>\tpara\n>\t| a | b |\n>\t|---|---|', '\n>'],
  ['- a\n\t| x | y |\n\t|---|---|', '\n'],
  // Telegram's limits: 20 columns, 16 levels (12 quotes, the table, its row, its cell and an entity in its text).
  ['para\n' + cols(20) + '\n' + delim(20), '\n'],
  [q(12) + 'para\n' + q(12) + '| a | b |\n' + q(12) + '|---|---|', '\n' + q(12).trimEnd()],
  [q(12) + 'para\n' + q(12) + '| @someone | b |\n' + q(12) + '|---|---|', '\n' + q(12).trimEnd()],
  [q(11) + 'para\n' + q(11) + '| **a** | b |\n' + q(11) + '|---|---|', '\n' + q(11).trimEnd()],
  [q(10) + 'para\n' + q(10) + '| <b>a</b> | b |\n' + q(10) + '|---|---|', '\n' + q(10).trimEnd()],
  [q(10) + 'para\n' + q(10) + '| ==a== | b |\n' + q(10) + '|---|---|', '\n' + q(10).trimEnd()],
  [q(10) + 'para\n' + q(10) + '| \\|\\|a\\|\\| | b |\n' + q(10) + '|---|---|', '\n' + q(10).trimEnd()],
  [q(11) + 'para\n' + q(11) + '| a[^1] | b |\n' + q(11) + '|---|---|\n\n[^1]: note', '\n' + q(11).trimEnd()],
  // Raw HTML and pairs closed where they open, a tag that closes nothing, and no element open around the paragraph.
  ['para <b>x</b> ==y==\n| a | b |\n|---|---|', '\n'],
  ['<p>x</p>\n\npara\n| a | b |\n|---|---|', '\n'],
  ['<hr>\n\npara\n| a | b |\n|---|---|', '\n'],
  ['<tg-map lat="1" long="2"/>\n\npara\n| a | b |\n|---|---|', '\n'],
  ['para\n| <b>a</b><br>==m== | b |\n|---|---|', '\n'],
  // A comment opens no element; a pair closed across formatting in the paragraph and in a cell.
  ['<!-- note -->\n\npara\n| a | b |\n|---|---|', '\n'],
  ['para ==a **b** c==\n| ==x *y* z== | b |\n|---|---|', '\n'],
  // Each cell's count even, though main's text pairs a mark across the pipe (sent live: main highlights `z | w`).
  ['Intro\n| a | b |\n|---|---|\n| x == y ==z | w== v == u |', '\n'],
]

const SAME = [
  '# H\n| a | b |\n|---|---|',
  '```\nx\n```\n| a | b |\n|---|---|',
  '| a | b |\n|---|---|',
  '- | a | b |\n  |---|---|',
  '[^1]: note\n    | a | b |\n    |---|---|\n\nText[^1]',
  '[^1]: note\n    > q\n    > | a | b |\n    > |---|---|\n\nText[^1]',
  '[^1]: note\n    - q\n      | a | b |\n      |---|---|\n\nText[^1]',
  'para\r| a | b |\r|---|---|',
  '> para\n| a | b |\n> |---|---|',
  '- a\n| x | y |\n  |---|---|',
  '1. a\n  | x | y |\n   |---|---|',
  '> > para\n> | a | b |\n> > |---|---|',
  '> - a\n| x | y |\n>   |---|---|',
  '> para\na | b\n> --|--',
  'para\n  | a | b |\n|---|---|',
  '> para\n>| a | b |\n> |---|---|',
  '- p\n\n  # H\n  | a | b |\n  |---|---|',
  'para\n- a', 'para\n> q', 'para\n# H', 'para\n```\nx\n```', 'para\n***', 'para\n<div>x</div>',
  'para\n```\n| a | b |\n|---|---|\n```',
  'para\n<div>\n| a | b |\n|---|---|\n</div>',
  'para\n\n| a | b |\n|---|---|',
  '| a | b |\n|---|---|\nafter',
  'para\n    | a | b |\n    |---|---|',
  '- a\n  - b',
  '[^1]: note\n    | a | b |\r    |---|---|\n\nText[^1]',
  // A lone CR in the paragraph, the table or the end of its last line.
  '> para\n> | a | b |\r> |---|---|',
  'para\n| a | b |\r|---|---|',
  'para\n| a | b |\r|---|---|\r| 1 | 2 |',
  'para\r\n| a | b |\r|---|---|',
  '- a\n  | x | y |\r  |---|---|',
  '- a\n  | x | y |\r  |---|---|\n- b',
  '> > para\n> > | a | b |\r> > |---|---|',
  '> - a\n>   | x | y |\r>   |---|---|',
  '- > a\n  > | x | y |\r  > |---|---|',
  'para\n| a | b |\n|---|---|\r| 1 | 2 |',
  'line one\rline two\n| a | b |\n|---|---|',
  'para\n| a | b |\n|---|---|\r',
  'para\n| a | b |\r\r|---|---|',
  '> para\n| a | b |\r> |---|---|\nafter',
  '- a\n| x | y |\r  |---|---|\nafter',
  '> para\n| a | b |\r> |---|---|',
  '- a\n| x | y |\r  |---|---|',
  '> > para\n> | a | b |\r> > |---|---|',
  'para\n  | a | b |\r|---|---|',
  '> para\n> | a | b |\r>|---|---|',
  // Over Telegram's limits: 21 columns in the head or a body row, 17 levels.
  'para\n' + cols(21) + '\n' + delim(21),
  'para\n' + cols(20) + '\n' + delim(20) + '\n' + cols(21, ' 1 |'),
  q(13) + 'para\n' + q(13) + '| a | b |\n' + q(13) + '|---|---|',
  q(13) + 'para\n' + q(13) + '| @someone | b |\n' + q(13) + '|---|---|',
  q(12) + 'para\n' + q(12) + '| **a** | b |\n' + q(12) + '|---|---|',
  q(11) + 'para\n' + q(11) + '| <b>a</b> | b |\n' + q(11) + '|---|---|',
  q(11) + 'para\n' + q(11) + '| ==a== | b |\n' + q(11) + '|---|---|',
  q(11) + 'para\n' + q(11) + '| \\|\\|a\\|\\| | b |\n' + q(11) + '|---|---|',
  q(12) + 'para\n' + q(12) + '| a[^1] | b |\n' + q(12) + '|---|---|\n\n[^1]: note',
  // A cell holds text only: an image or an HTML tag Telegram makes a block from.
  'para\n| ![x](https://example.com/p.jpg) | b |\n|---|---|',
  'para\n| ![x][p] | b |\n|---|---|\n\n[p]: https://example.com/p.jpg',
  'para\n| <img src="https://example.com/p.jpg"> | b |\n|---|---|',
  'para\n| a <blockquote>q</blockquote> | b |\n|---|---|',
  // <details> other than as sent live.
  '- x\n  <details><summary>S</summary>\n  Text\n  | a | b |\n  |---|---|\n  </details>',
  '> <details><summary>S</summary>\n> Text\n> | a | b |\n> |---|---|\n> </details>',
  '<details><summary>S</summary>\n> Text\n> | a | b |\n> |---|---|\n</details>',
  '<details><summary>S</summary>Text\n| a | b |\n|---|---|\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\nNote <details><summary>B</summary>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\nNote <summary>B</summary> more\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|',
  '<details><summary>A</summary>\n<details><summary>B</summary>\nText\n| a | b |\n|---|---|\n</details>\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\n<details><summary>B</summary>\nx\n</details>\n</details>',
  ' <details><summary>S</summary>\nText\n| a | b |\n|---|---|\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\n </details>',
  'Text\n| a | <details> |\n|---|---|',
  'Text <summary>x</summary>\n| a | b |\n|---|---|',
  '<details><summary>S</summary>\nText\n| a | ' + '<b>'.repeat(6) + 'x' + '</b>'.repeat(6) + ' |\n|---|---|\n</details>',
  // Raw HTML open around the paragraph: a collage, a slideshow, a quote, a dropped tag, a summary outside a section, an earlier tag.
  '<tg-collage>\n\npara\n| a | b |\n|---|---|\n\n</tg-collage>',
  '<tg-slideshow>\n\npara\n| a | b |\n|---|---|\n\n</tg-slideshow>',
  '<blockquote>\n\npara\n| a | b |\n|---|---|\n\n</blockquote>',
  '<div>\n\npara\n| a | b |\n|---|---|\n\n</div>',
  '<summary>\n\npara\n| a | b |\n|---|---|\n\n</summary>',
  'Intro <span>x\n\npara\n| a | b |\n|---|---|',
  // A tag, a == or a || the line would split from its pair, across the paragraph and the table or across cells.
  '<b>para\n| a | b |\n|---|---|\n| c | d</b> |',
  '<tg-spoiler>para\n| a | b |\n|---|---|\n| c | d</tg-spoiler> |',
  '==para\n| a | b |\n|---|---|\n| x== | y |',
  '||para\n| a | b |\n|---|---|',
  'para\n| <b>a | b</b> |\n|---|---|',
  'para\n| ==a | b== |\n|---|---|',
  'para\n| \\|\\|a | b\\|\\| |\n|---|---|',
  'para\n| a || b |\n|---|---|---|',
  // A cell holding a tag the page builds no text from.
  'para\n| <tr> | b |\n|---|---|',
  'para\n| <a name="x"></a>a | b |\n|---|---|',
  'para\n| <a href="https://t.me">a</a> | b |\n|---|---|',
  'para\n| <kbd>a</kbd> | b |\n|---|---|',
  'para\n| <tg-map lat="1" long="2"/> | b |\n|---|---|',
  // A == read one way and not another: an escape or a reference beside a mark, an escape that joins two =, four in a row.
  'para \\=\\= x ==\n| a | b |\n|---|---|\n| \\=\\= c == | d |',
  'para\n| a | b |\n|---|---|\n| \\=\\= c == | \\=\\= d == |',
  'para\n| a | b |\n|---|---|\n| &#61;= c == | &#61;= d == |',
  'para a \\== b ==\n| a | b |\n|---|---|',
  'para \\=\\= x \\==\n| a | b |\n|---|---|',
  'para \\\\== b \\==\n| a | b |\n|---|---|',
  'para ==== x\n| a | b |\n|---|---|',
  'para\n| a ==== b | c |\n|---|---|',
  // A tag inside a comment counts as left open; a closing tag inside a <pre> closes nothing; a cell holding a comment.
  '<!-- <b> -->\n\npara\n| a | b |\n|---|---|',
  'Intro <span>x\n\n<!-- </span> -->\n\npara\n| a | b |\n|---|---|',
  'Intro <span>x\n\n<!-- a > b </span> -->\n\npara\n| a | b |\n|---|---|',
  '<tg-collage>\n\n<!-- </tg-collage> -->\n\npara\n| a | b |\n|---|---|\n\n</tg-collage>',
  'Intro <span>x\n\n<pre>\n</span>\n</pre>\n\npara\n| a | b |\n|---|---|',
  'para\n| <!-- c --> a | b |\n|---|---|',
  // A head row with no leading pipe that starts with a list marker that cannot interrupt a paragraph
  // (an ordered one not numbered 1, or an empty item): the blank line would open a list.
  'Steps\n3. Deploy | Owner\n---|---\n| x | y |',
  'para\n2) a | b\n--|--\n| 1 | 2 |',
  'para\n10) Step | Detail\n---|---',
  'para\n0) a | b\n--|--',
  '> para\n> 3) x | y\n> --|--',
  '> para\n> 2. x | y\n> --|--',
  '- a\n  2) x | y\n  --|--',
  '- a\n  3. x | y\n  --|--',
  'para\n2.\ta | b\n--|--',
  'para\n123. a | b\n--|--',
  'para\n123456789. a | b\n--|--',
  'para\n*\n|---|',
  'para\n+\n|---|',
  'para\n1.\n|---|',
  'para\n2.\n|---|',
  '> para\n> *\n> |---|',
  '- a\n  1.\n  |---|',
]

// AXEG0/claude-telegram's tests for the blank line above a table right under a
// paragraph. The outputs of the reported shape, a table under a list item's text,
// a CRLF line break above the table, a table two quotes deep and a table under
// text inside a top-level <details> were sent to Telegram and read back; the
// rest are checked against the GFM parse only.
{
  test('a table right under a paragraph: corpus: one inserted line where it fires, byte-identical elsewhere, the GFM tree kept', () => {
    for (const [md, line] of FIRES) {
      const out = richMarkdown(md)
      let i = 0
      while (i < md.length && out[i] === md[i]) i++
      assert.deepEqual([md, out.slice(i, i + line.length), out.slice(i + line.length)], [md, line, md.slice(i)])
      assert.deepEqual([md, tree(out)], [md, tree(md)])
    }
    for (const md of SAME) assert.deepEqual([md, richMarkdown(md)], [md, md])
    // Head rows near a list marker, generated, at the top level: bare and with cells, after an LF, and bare after a CRLF.
    // A table to the parser gains its line exactly when a blank line above it keeps the tree, and is as written otherwise.
    const parse = s => parseMarkdown(s)
    const shape = n => 'value' in n ? [n.type, n.value] : [n.type, ...(n.children ?? []).map(shape)]
    const ascii = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(c => c !== '$') // a $ gains its escape, held by its own test
    const spaces = Array.from({ length: 0x10000 }, (_, i) => String.fromCharCode(i)).filter(c => /\s/.test(c) && c !== '\n' && c !== '\r')
    const numbers = [...Array.from({ length: 10 }, (_, i) => String(i)), '00', '01', '09', '007', '10', '99', '1'.repeat(9), '9'.repeat(9), '0'.repeat(8) + '5', '1'.repeat(10), '9'.repeat(10), 'a', 'Note', '(1', 'x1']
    const markers = ['*', '+', '-', '1.', '1)', '3.', '3)']
    // Each part the check reads, swept on its own: the first character, the number, the character after it, and what follows the marker.
    const heads = [...ascii, '\u2022', '\u2023', '\u25e6', '\u00b7', '\u2013', '\u2014', '**', '--', '++']
    for (const n of numbers) for (const m of ['.', ')', '']) heads.push(n + m)
    for (const m of ascii) heads.push('3' + m)
    for (const h of markers) for (const t of [...spaces, 'x']) heads.push(h + t)
    const forms = heads.flatMap(h => [[h + ' ', 'a | b', '--|--', '\n'], [h, '', '|---|', '\n']])
    for (const h of markers) forms.push([h, '', '|---|', '\r\n'])
    let swept = 0
    for (const [head, row, sep, nl] of forms) {
      const md = `para${nl}${head}${row}${nl}${sep}`
      const p = parse(md)
      if (p.children.map(c => c.type).join(',') !== 'paragraph,table') continue
      swept++
      const gained = `para${nl}${nl}${head}${row}${nl}${sep}`
      const want = JSON.stringify(shape(parse(gained))) === JSON.stringify(shape(p)) ? gained : md
      assert.deepEqual([md, richMarkdown(md)], [md, want])
    }
    assert.ok(swept > 800, String(swept))
  })

  test('a table right under a paragraph: fires: exact output', () => {
    assert.equal(richMarkdown('**The real risks**\n| Risk | Impact |\n|---|---|\n| a | b |'),
      '**The real risks**\n\n| Risk | Impact |\n|---|---|\n| a | b |')
    assert.equal(richMarkdown('- a\n  | x | y |\n  |---|---|'), '- a\n\n  | x | y |\n  |---|---|')
    assert.equal(richMarkdown('Intro\r\n| a | b |\r\n|---|---|'), 'Intro\r\n\r\n| a | b |\r\n|---|---|')
    assert.equal(richMarkdown('> para\r\n> | a | b |\r\n> |---|---|'), '> para\r\n>\r\n> | a | b |\r\n> |---|---|')
    assert.equal(richMarkdown('para  \n| a | b |\n|---|---|'), 'para  \n\n| a | b |\n|---|---|')
    assert.equal(richMarkdown('> > para\n> > | a | b |\n> > |---|---|'), '> > para\n> >\n> > | a | b |\n> > |---|---|')
    // A name sent as &lt; is text to Telegram, no tag.
    assert.equal(richMarkdown('Vec<String>\n| a | b |\n|---|---|'), 'Vec&lt;String>\n\n| a | b |\n|---|---|')
  })

  test('a table right under a paragraph: details: a table under text inside a top-level <details> gets the line, as sent live', () => {
    assert.equal(richMarkdown('<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>'),
      '<details><summary>S</summary>\nText\n\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>')
    assert.equal(richMarkdown('Before\n\n<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\nMore\n</details>\n\nAfter'),
      'Before\n\n<details><summary>S</summary>\nText\n\n| a | b |\n|---|---|\n\nMore\n</details>\n\nAfter')
    // 16 levels: the section, the table, its row, its cell, an entity in its text and 11 tags in the cell.
    const at16 = '<details><summary>S</summary>\nText\n| a | ' + '<b>'.repeat(5) + 'x' + '</b>'.repeat(5) + '<br> |\n|---|---|\n</details>'
    assert.equal(richMarkdown(at16), at16.replace('Text\n', 'Text\n\n'))
  })

  test('a table right under a paragraph: details arrangements: no <summary>, <details open> and a <summary> on its own line get the line, as sent live', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n</details>'
    for (const head of ['<details>\n\n', '<details>\n', '<details open><summary>S</summary>\n', '<details>\n<summary>S</summary>\n',
      '<details>\n<summary>S</summary>\n\n', '<details open>\n<summary>S</summary>\n', '<details open>\n<summary>S</summary>\n\n'])
      assert.deepEqual([head, richMarkdown(head + 'Text\n' + table)], [head, head + 'Text\n\n' + table])
  })

  test('a table right under a paragraph: time: a long HTML block whose < meet no > is read in time linear in its length', () => {
    const md = '<p>x</p>\n' + 'x<y '.repeat(50_000) + '\n\npara\n| a | b |\n|---|---|'
    const start = performance.now()
    const parts = richParts(md)
    assert.ok(performance.now() - start < 3000)
    assert.deepEqual(parts.map(p => p.rich), [undefined, 'para\n\n| a | b |\n|---|---|'])
  })

  test('a table right under a paragraph: dollar: a $ that opens the table keeps its escape and the blank line', () => {
    assert.equal(richMarkdown('para\n$a | b\n--|--'), 'para\n\n\\$a | b\n--|--')
  })

  test('a table right under a paragraph: a cut between a paragraph and its table adds no line to either part', () => {
    const md = 'p'.repeat(40) + '\n| a | b |\n|---|---|\n| 1 | 2 |'
    assert.deepEqual(richParts(md, { bytes: 45, blocks: 400 }), [
      { rich: 'p'.repeat(40), plain: 'p'.repeat(40) },
      { rich: '| a | b |\n|---|---|\n| 1 | 2 |', plain: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ])
  })

  const top = 'p'.repeat(40) + '\n| a | b |\n|---|---|\n| 1 | 2 |'
  const quote = '> ' + 'q'.repeat(40) + '\n> | a | b |\n> |---|---|\n> | 1 | 2 |'
  const items = '- ' + 'l'.repeat(40) + '\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- b\n- c'
  const item = '- ' + 'l'.repeat(40) + '\n  | a | b |\n  |---|---|\n  | 1 | 2 |'
  const deep = '> > ' + 'q'.repeat(40) + '\n> > | a | b |\n> > |---|---|\n> > | 1 | 2 |'
  const det = '<details><summary>S</summary>\n' + 'd'.repeat(30) + '\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>'
  // Each text with the bytes its line adds.
  const AT = [[top, 1], [quote, 2], [items, 1], [item, 1], [deep, 4], [det, 1]]
  const lim = bytes => ({ bytes, blocks: 400 })
  // editRich as the edit_message tool runs it: the parse, then the edit.
  const editTo = async (calls, text) => editRichParsed({
    send: async (method, params) => { calls.push(params); return true }, chatId: '1', messageId: 7, text, rich: await richEditParse(text, silent), log: silent,
  })

  test('a table right under a paragraph: limit kept: a text that fits only without its line is one rich part as written; with room for the line, one part with it', () => {
    for (const [md, add] of AT) {
      assert.deepEqual([md, richParts(md, lim(md.length))], [md, [{ rich: md, plain: md }]])
      const fixed = richMarkdown(md)
      assert.deepEqual([md, Buffer.byteLength(fixed)], [md, md.length + add])
      assert.deepEqual([md, richParts(md, lim(md.length + add))], [md, [{ rich: fixed, plain: md }]])
    }
  })

  test('a table right under a paragraph: limit cut: in a longer reply the cuts fall where main puts them, and only the part with room gets its line', () => {
    const md = top + '\n\nafter'
    assert.deepEqual(richParts(md, lim(top.length)), [{ rich: top, plain: top }, { rich: 'after', plain: 'after' }])
    assert.deepEqual(richParts(md, lim(top.length + 1)), [{ rich: richMarkdown(top), plain: top }, { rich: 'after', plain: 'after' }])
  })

  test('a table right under a paragraph: limit list: a list cut between its items keeps main\'s cut, and its first item gets its line only with room for it', () => {
    const first = items.slice(0, items.indexOf('\n- b'))
    assert.deepEqual(richParts(items, lim(first.length)), [{ rich: first, plain: first }, { rich: '- b\n- c', plain: '- b\n- c' }])
    assert.deepEqual(richParts(items, lim(first.length + 1)), [{ rich: richMarkdown(first), plain: first }, { rich: '- b\n- c', plain: '- b\n- c' }])
    // The item with the table last, so it is the list's last part.
    const tail = '- b\n' + item
    assert.deepEqual(richParts(tail, lim(item.length)), [{ rich: '- b', plain: '- b' }, { rich: item, plain: item }])
    assert.deepEqual(richParts(tail, lim(item.length + 1)), [{ rich: '- b', plain: '- b' }, { rich: richMarkdown(item), plain: item }])
  })

  test('a table right under a paragraph: limit edit: at 30,000 bytes an edit is one rich edit as written; a byte under, it carries the line', async () => {
    for (const md of [top, item]) {
      const pad = n => md.startsWith('- ') ? md.replace('- ', '- ' + 'l'.repeat(n - md.length)) : 'p'.repeat(n - md.length) + md
      const full = pad(30_000), room = pad(29_999)
      assert.equal(Buffer.byteLength(full), 30_000)
      assert.equal(await richEditParse(full, silent), full)
      const calls = []
      await editTo(calls, full)
      await editTo(calls, room)
      assert.deepEqual(calls, [
        { chat_id: '1', message_id: 7, rich_message: { markdown: full } },
        { chat_id: '1', message_id: 7, rich_message: { markdown: richMarkdown(room) } },
      ])
      assert.notEqual(richMarkdown(room), room)
    }
  })

  // n one-word paragraphs, each a block.
  const words = n => 'w\n\n'.repeat(n)
  const pair = 'para\n| a | b |\n|---|---|'

  test('a table right under a paragraph: blocks edit: an edit of 400 blocks, counted as Telegram counts them, carries the line; of 401, it is one rich edit as written', async () => {
    // n paragraphs, then the paragraph, the table and its row: n + 3 blocks.
    const calls = []
    await editTo(calls, words(397) + pair)
    await editTo(calls, words(398) + pair)
    assert.deepEqual(calls, [
      { chat_id: '1', message_id: 7, rich_message: { markdown: words(397) + 'para\n\n| a | b |\n|---|---|' } },
      { chat_id: '1', message_id: 7, rich_message: { markdown: words(398) + pair } },
    ])
    assert.equal(await richEditParse(words(398) + pair, silent), words(398) + pair)
  })

  test('a table right under a paragraph: blocks edit over the budget: an edit of 600 top-level blocks is still one rich edit, as main sends it', async () => {
    const calls = []
    await editTo(calls, words(600) + pair)
    assert.deepEqual(calls, [{ chat_id: '1', message_id: 7, rich_message: { markdown: words(600) + pair } }])
  })

  test('a table right under a paragraph: blocks nested: list items, their paragraphs and table rows count, though the list is one top-level block', () => {
    // n paragraphs, a list (1) of 101 items (101), their paragraphs (101), the table (1) and its row (1): n + 205.
    const list = n => words(n) + '- a\n  | x | y |\n  |---|---|\n' + '- b\n'.repeat(100)
    for (const [n, line] of [[195, true], [196, false]]) {
      const md = list(n), sent = md.trimEnd()
      const parts = richParts(md)
      assert.deepEqual([n, parts.length], [n, 1])
      assert.deepEqual([n, parts[0].rich], [n, line ? sent.replace('- a\n', '- a\n\n') : sent])
    }
    // A table's rows: n paragraphs, the paragraph, the table, its head row and 10 rows: n + 13.
    const rows = n => words(n) + pair + '\n| 1 | 2 |'.repeat(10)
    assert.equal(richParts(rows(387))[0].rich, richMarkdown(rows(387)))
    assert.equal(richParts(rows(388))[0].rich, rows(388))
  })

  test('a table right under a paragraph: blocks details: one <details> section over 400 blocks is one part as written; at 400, it carries its line', () => {
    // The section (1), the summary line's paragraph (1), n paragraphs, the paragraph, the table and its row: n + 5.
    const sec = n => '<details><summary>S</summary>\n' + words(n) + 'Text\n| a | b |\n|---|---|\n</details>'
    assert.deepEqual(richParts(sec(395)), [{ rich: sec(395).replace('Text\n', 'Text\n\n'), plain: sec(395) }])
    assert.deepEqual(richParts(sec(396)), [{ rich: sec(396), plain: sec(396) }])
  })

  test('a table right under a paragraph: blocks html: raw HTML counts two blocks per tag', () => {
    // The paragraph, the table and its row (3), <div>x</div> (4) and n paragraphs: n + 7.
    const md = n => pair + '\n\n<div>x</div>\n\n' + words(n).trimEnd()
    assert.equal(richParts(md(393))[0].rich, richMarkdown(md(393)))
    assert.equal(richParts(md(394))[0].rich, md(394))
  })

  test('a table right under a paragraph: blocks image: a Markdown image counts two blocks, inside raw HTML too', () => {
    // The pair (3), the image's paragraph (1) and the image (2), and n paragraphs: n + 6.
    const md = n => pair + '\n\n![](https://example.com/p.jpg)\n\n' + words(n).trimEnd()
    assert.equal(richParts(md(394))[0].rich, richMarkdown(md(394)))
    assert.equal(richParts(md(395))[0].rich, md(395))
    // The pair (3), a collage's two tags and two images, two each (8), and n paragraphs: n + 11.
    const col = n => pair + '\n\n<tg-collage>\n![](https://example.com/a.jpg)\n![](https://example.com/b.jpg)\n</tg-collage>\n\n' + words(n).trimEnd()
    assert.equal(richParts(col(389))[0].rich, richMarkdown(col(389)))
    assert.equal(richParts(col(390))[0].rich, col(390))
  })

  test('a table right under a paragraph: blocks cut: a list piece after a cut counts its list again', () => {
    // The first item fills a part; the second piece holds k items (2 each) and the item
    // with the table (4), and its list opens again: 2k + 5.
    const md = k => '- ' + 'x'.repeat(996) + '\n' + '- w\n'.repeat(k) + '- a\n  | x | y |\n  |---|---|'
    for (const [k, line] of [[197, true], [198, false]]) {
      const parts = richParts(md(k), { bytes: 1000, blocks: 400 })
      assert.deepEqual([k, parts.length, parts[0].plain.length], [k, 2, 998])
      const second = parts[1].plain
      assert.deepEqual([k, parts[1].rich], [k, line ? second.replace('- a\n', '- a\n\n') : second])
      // The same piece in the middle, a third item filling a part after it.
      const three = richParts(md(k) + '\n- ' + 'y'.repeat(996), { bytes: 1000, blocks: 400 })
      assert.deepEqual([k, three.length, three[1].plain], [k, 3, second])
      assert.deepEqual([k, three[1].rich], [k, line ? second.replace('- a\n', '- a\n\n') : second])
    }
  })

  test('a table right under a paragraph: editRichParsed carries the blank line', async () => {
    const calls = []
    await editTo(calls, 'para\n| a | b |\n|---|---|')
    assert.deepEqual(calls, [{ chat_id: '1', message_id: 7, rich_message: { markdown: 'para\n\n| a | b |\n|---|---|' } }])
  })
}
