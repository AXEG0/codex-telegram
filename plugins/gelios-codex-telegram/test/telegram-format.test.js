import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTelegramMarkdown, renderTelegramMarkdown, splitTelegramMessage } from '../src/telegram-format.js'

function entityText(rendered, type) {
  return rendered.entities
    .filter(entity => entity.type === type)
    .map(entity => rendered.text.slice(entity.offset, entity.offset + entity.length))
}

test('Markdown is rendered as Telegram text and UTF-16 entities', () => {
  const rendered = renderTelegramMarkdown([
    '# Release summary',
    '',
    '**Done** and *ready* with [details](https://example.com/a_(b)).',
    '- first',
    '- `npm test`',
    '',
    '```js',
    'const ok = true',
    '```',
    '',
    '> quoted ~~old~~',
  ].join('\n'))

  assert.equal(rendered.text, [
    'Release summary',
    '',
    'Done and ready with details.',
    '• first',
    '• npm test',
    '',
    'const ok = true',
    '',
    'quoted old',
  ].join('\n'))
  assert.deepEqual(entityText(rendered, 'bold'), ['Release summary', 'Done'])
  assert.deepEqual(entityText(rendered, 'italic'), ['ready'])
  assert.deepEqual(entityText(rendered, 'code'), ['npm test'])
  assert.deepEqual(entityText(rendered, 'pre'), ['const ok = true'])
  assert.deepEqual(entityText(rendered, 'blockquote'), ['quoted old'])
  assert.deepEqual(entityText(rendered, 'strikethrough'), ['old'])
  assert.equal(rendered.entities.find(entity => entity.type === 'text_link').url, 'https://example.com/a_(b)')
  assert.equal(rendered.entities.find(entity => entity.type === 'pre').language, 'js')
})

test('code entities remain disjoint from surrounding styles', () => {
  const rendered = renderTelegramMarkdown('# Run `npm test` safely')
  const code = rendered.entities.find(entity => entity.type === 'code')
  const bold = rendered.entities.filter(entity => entity.type === 'bold')
  assert.equal(rendered.text, 'Run npm test safely')
  assert.deepEqual(entityText(rendered, 'bold'), ['Run ', ' safely'])
  assert.ok(bold.every(entity => entity.offset + entity.length <= code.offset || entity.offset >= code.offset + code.length))
})

test('Telegram-exclusive entities never overlap', () => {
  const rendered = renderTelegramMarkdown('> See [the guide](https://example.com) and `npm test`.')
  const exclusive = rendered.entities.filter(entity => !['bold', 'italic', 'underline', 'strikethrough', 'spoiler'].includes(entity.type))
  for (let left = 0; left < exclusive.length; left += 1) {
    for (let right = left + 1; right < exclusive.length; right += 1) {
      const a = exclusive[left]
      const b = exclusive[right]
      assert.ok(a.offset + a.length <= b.offset || b.offset + b.length <= a.offset)
    }
  }
  assert.deepEqual(entityText(rendered, 'text_link'), ['the guide'])
  assert.deepEqual(entityText(rendered, 'code'), ['npm test'])
})

test('GFM tables become aligned Telegram preformatted text', () => {
  const rendered = renderTelegramMarkdown([
    '| Name | State |',
    '| --- | --- |',
    '| Gelios | **ready** |',
  ].join('\n'))
  assert.equal(rendered.text, 'Name    State\nGelios  ready')
  assert.deepEqual(rendered.entities, [{ type: 'pre', offset: 0, length: rendered.text.length }])
})

test('long formatted messages split without losing text, styles, or surrogate pairs', () => {
  const rendered = renderTelegramMarkdown(`**${'😀'.repeat(2200)}**`)
  const chunks = splitTelegramMessage(rendered, { maxLength: 4095, maxEntities: 90 })
  assert.equal(chunks.map(chunk => chunk.text).join(''), rendered.text)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 4095)
    assert.doesNotMatch(chunk.text.at(-1) || '', /[\uD800-\uDBFF]/u)
    assert.doesNotMatch(chunk.text[0] || '', /[\uDC00-\uDFFF]/u)
    assert.deepEqual(entityText(chunk, 'bold'), [chunk.text])
  }
  const paragraphs = splitTelegramMessage(renderTelegramMarkdown(`${'x'.repeat(36)}\n\ny`), { maxLength: 37 })
  assert.ok(paragraphs.every(chunk => chunk.text.length <= 37))
  assert.equal(paragraphs.map(chunk => chunk.text).join(''), `${'x'.repeat(36)}\n\ny`)
})

test('entity budgets create additional lossless chunks', () => {
  const markdown = Array.from({ length: 35 }, (_, index) => `**item-${index}**`).join(' ')
  const rendered = renderTelegramMarkdown(markdown)
  const chunks = splitTelegramMessage(rendered, { maxLength: 4096, maxEntities: 10 })
  assert.equal(chunks.map(chunk => chunk.text).join(''), rendered.text)
  assert.ok(chunks.length >= 4)
  assert.ok(chunks.every(chunk => chunk.entities.length <= 10))
})

test('unfinished Markdown remains visible plain text', () => {
  assert.deepEqual(formatTelegramMarkdown('2 < 3 & **unfinished'), [{
    text: '2 < 3 & **unfinished',
    entities: [],
  }])
  assert.deepEqual(formatTelegramMarkdown('[]()'), [{ text: '[]()', entities: [] }])
  assert.deepEqual(formatTelegramMarkdown('```\n```'), [{ text: '```\n```', entities: [] }])
})
