#!/usr/bin/env node
// Refuses a test file that waits on a clock of its own. Every wait goes
// through `until` in test/support/wait.js, which ends when its check holds or
// when the bound of the test or hook running it ends. This check reports:
//   - a loop that polls: a `while`, `do` or counted `for` loop that sleeps on a
//     timer in its own function, or whose condition reads a clock;
//   - an embedded program (a string a test runs as code) that compares a clock
//     reading, the shape of a deadline written for another process;
//   - a test or hook that waits through `until` without declaring a `timeout`,
//     since its bound is the only thing that ends a wait that never holds.
// The file-level teardown in test/fixtures.js runs under no test's bound and
// keeps its own escalation limits, so it is the one file not read.
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'await', 'yield', 'instanceof'])
const OPENERS = { '(': ')', '[': ']', '{': '}', '${': '}$' }
const CLOSERS = new Set([')', ']', '}', '}$'])
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new'])
const HOOKS = new Set(['before', 'after', 'beforeEach', 'afterEach'])
const CLOCK_IN_PROGRAM = /Date\.now\(\)\s*(?:-\s*[\w.]+\s*)?[<>]|[<>]=?\s*Date\.now\(\)|performance\.now\(\)\s*(?:-\s*[\w.]+\s*)?[<>]|[<>]=?\s*performance\.now\(\)/

export function tokenize(source) {
  const tokens = [], templates = [], lineStarts = [0]
  for (let k = 0; k < source.length; k++) if (source[k] === '\n') lineStarts.push(k + 1)
  const lineAt = position => {
    let low = 0, high = lineStarts.length - 1
    while (low < high) { const middle = (low + high + 1) >> 1; if (lineStarts[middle] <= position) low = middle; else high = middle - 1 }
    return low + 1
  }
  let i = source.startsWith('#!') ? source.indexOf('\n') : 0, depth = 0
  const push = (type, value, start) => tokens.push({ type, value, line: lineAt(start) })
  const fail = (what, at) => { throw new Error(`${what} at line ${lineAt(at)}`) }
  const regexAllowed = () => {
    const last = tokens.at(-1)
    if (!last) return true
    if (last.type === 'name') return KEYWORDS_BEFORE_REGEX.has(last.value)
    if (last.type !== 'punct') return false
    return !CLOSERS.has(last.value)
  }
  const template = start => {
    let text = ''
    while (i < source.length) {
      const c = source[i]
      if (c === '\\') { text += source.slice(i, i + 2); i += 2; continue }
      if (c === '`') { i++; push('string', text, start); return }
      if (c === '$' && source[i + 1] === '{') { push('string', text, start); templates.push(depth); depth++; push('punct', '${', i); i += 2; return }
      text += c; i++
    }
    fail('unterminated template', start)
  }
  while (i < source.length) {
    const c = source[i], start = i
    if (/\s/.test(c)) { i++; continue }
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) fail('unterminated comment', start); i = end + 2; continue }
    if (c === '"' || c === "'") {
      let text = ''; i++
      while (source[i] !== c) {
        if (i >= source.length || source[i] === '\n') fail('unterminated string', start)
        if (source[i] === '\\') { text += source.slice(i, i + 2); i += 2 } else text += source[i++]
      }
      i++; push('string', text, start); continue
    }
    if (c === '`') { i++; template(start); continue }
    if (c === '/' && regexAllowed()) {
      i++; let inClass = false
      for (;;) {
        const d = source[i]
        if (d === undefined || d === '\n') fail('unterminated regular expression', start)
        if (d === '\\') { i += 2; continue }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        i++
      }
      i++; while (/[a-z]/i.test(source[i] ?? '')) i++
      push('regex', source.slice(start, i), start); continue
    }
    if (/[A-Za-z_$]/.test(c)) { while (i < source.length && /[\w$]/.test(source[i])) i++; push('name', source.slice(start, i), start); continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) { while (i < source.length && /[\w.]/.test(source[i])) i++; push('number', source.slice(start, i), start); continue }
    if (c === '{') { depth++; i++; push('punct', '{', start); continue }
    if (c === '}') {
      i++; depth--
      if (templates.at(-1) === depth) { templates.pop(); push('punct', '}$', start); template(start); continue }
      push('punct', '}', start); continue
    }
    for (const operator of ['...', '=>', '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '?.']) {
      if (source.startsWith(operator, i)) { i += operator.length; push('punct', operator, start); break }
    }
    if (i === start) { i++; push('punct', c, start) }
  }
  if (depth !== 0 || templates.length) throw new Error('unbalanced braces at the end of the file')
  return tokens
}

function closing(tokens, index) {
  let depth = 0
  for (let k = index; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type !== 'punct') continue
    if (value in OPENERS) depth++
    else if (CLOSERS.has(value) && --depth === 0) return k
  }
  throw new Error(`unbalanced ${tokens[index].value} at line ${tokens[index].line}`)
}

const CONTINUES_AFTER = new Set(['(', '[', '{', ',', '=>', '&&', '||', '??', '+', '-', '*', '/', '=', '?', ':', '.', '?.', '!', '${'])
const CONTINUES_BEFORE = new Set(['.', '?.', '?', ':', '&&', '||', '??', '+', '=', ')', ']', '}', '}$', ','])
// The last token of the statement or expression starting at `index`: a block,
// or tokens up to a `;`, a closer of the enclosing group, or a line break that
// ends it.
function statementEnd(tokens, index, stopAtComma = false) {
  if (tokens[index]?.value === '{') return closing(tokens, index)
  let k = index
  for (; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type === 'punct' && (CLOSERS.has(value) || value === ';' || (stopAtComma && value === ','))) return k - 1
    if (type === 'punct' && value in OPENERS) k = closing(tokens, k)
    const next = tokens[k + 1]
    if (next && next.line !== tokens[k].line && !CONTINUES_AFTER.has(tokens[k].value) && !CONTINUES_BEFORE.has(next.value)) return k
  }
  return k - 1
}

// Function bodies, as token spans, so a sleep inside a nested function does
// not count for a loop outside it.
function functionSpans(tokens) {
  const spans = []
  for (let k = 0; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type === 'name' && value === 'function') {
      let open = k + 1
      while (tokens[open] && tokens[open].value !== '(') open++
      const body = closing(tokens, open) + 1
      if (tokens[body]?.value === '{') spans.push([k, closing(tokens, body)])
    } else if (type === 'punct' && value === '=>') {
      spans.push([k, tokens[k + 1]?.value === '{' ? closing(tokens, k + 1) : statementEnd(tokens, k + 1, true)])
    } else if (type === 'name' && tokens[k + 1]?.value === '(' && !NOT_METHODS.has(value) && tokens[k - 1]?.value !== '.' &&
      ['{', ',', ';', '}', 'async', 'static', 'get', 'set', '*'].includes(tokens[k - 1]?.value)) {
      const after = closing(tokens, k + 1) + 1
      if (tokens[after]?.value === '{') spans.push([k, closing(tokens, after)])
    }
  }
  return spans
}
function innermost(spans, index) {
  let best = null
  for (const span of spans) if (span[0] <= index && index <= span[1] && (!best || span[0] > best[0])) best = span
  return best
}

// Names that sleep: local helpers whose whole body is a timer promise, and
// timer promises imported from node:timers/promises.
function sleepers(tokens) {
  const names = new Set()
  for (let k = 0; k < tokens.length - 2; k++) {
    const { value } = tokens[k]
    if (['const', 'let', 'var', 'function'].includes(value) && tokens[k + 1].type === 'name') {
      const end = value === 'function' ? closing(tokens, closing(tokens, k + 2) + 1) : statementEnd(tokens, k + 3)
      const body = tokens.slice(k + 2, end + 1)
      if (body.length < 40 && body.some(token => token.value === 'Promise') && body.some(token => ['setTimeout', 'setImmediate'].includes(token.value))) names.add(tokens[k + 1].value)
    }
    if (value === 'import' && tokens[k + 1].value === '{') {
      const close = closing(tokens, k + 1)
      if (tokens[close + 2]?.type === 'string' && /^(node:)?timers\/promises$/.test(tokens[close + 2].value)) {
        for (let n = k + 2; n < close; n++) if (tokens[n].type === 'name' && tokens[n + 1]?.value !== 'as') names.add(tokens[n].value)
      }
    }
  }
  return names
}

// Token indexes where a sleep starts: a call to a sleeper, a short
// `new Promise(...)` around a timer, or a blocking Atomics.wait.
function sleeps(tokens) {
  const names = sleepers(tokens), found = []
  for (let k = 0; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type !== 'name' || tokens[k - 1]?.value === '.') continue
    if (names.has(value) && tokens[k + 1]?.value === '(' && !['function', 'const', 'let', 'var'].includes(tokens[k - 1]?.value)) found.push(k)
    else if (value === 'new' && tokens[k + 1]?.value === 'Promise' && tokens[k + 2]?.value === '(') {
      const close = closing(tokens, k + 2)
      if (close - k < 40 && tokens.slice(k, close).some(token => ['setTimeout', 'setImmediate'].includes(token.value))) found.push(k)
    } else if ((value === 'Atomics' || value === 'scheduler') && tokens[k + 1]?.value === '.' && tokens[k + 2]?.value === 'wait') found.push(k)
  }
  return found
}

function pollingLoops(tokens, spans) {
  const sleeping = sleeps(tokens), found = [], doTails = new Set()
  for (let k = 0; k < tokens.length; k++) {
    const { type, value, line } = tokens[k]
    if (type !== 'name' || !['for', 'while', 'do'].includes(value) || tokens[k - 1]?.value === '.') continue
    let headerEnd = k, end
    if (value === 'do') {
      end = statementEnd(tokens, k + 1)
      if (tokens[end + 1]?.value === 'while') { doTails.add(end + 1); headerEnd = closing(tokens, end + 2); end = headerEnd }
    } else {
      if (tokens[k + 1]?.value !== '(') continue
      headerEnd = closing(tokens, k + 1)
      // for...of and for...in walk a collection; they poll nothing by themselves.
      if (value === 'for' && !tokens.slice(k + 2, headerEnd).some(token => token.value === ';')) continue
      // the condition of a do...while, read with its do
      if (doTails.has(k)) continue
      end = statementEnd(tokens, headerEnd + 1)
    }
    const home = innermost(spans, k)
    const header = tokens.slice(k, headerEnd + 1)
    if (value === 'for' && fixedPause(tokens, spans, home, k + 1, headerEnd, end)) continue
    const clock = header.some((token, n) => ['Date', 'performance'].includes(token.value) && header[n + 1]?.value === '.' && header[n + 2]?.value === 'now')
    const sleep = sleeping.find(index => index > k && index <= end && innermost(spans, index) === home)
    if (sleep !== undefined) found.push({ line, rule: 'poll', detail: `${value} loop sleeps on ${tokens[sleep].value}` })
    else if (clock) found.push({ line, rule: 'poll', detail: `${value} loop reads a clock in its condition` })
  }
  return found
}

// A counted loop that waits for nothing: its condition compares only its own
// counter with a number, and no break, return or throw leaves it early. It
// paces a fixed number of steps, such as ticks before a check that nothing
// happened, and has no condition to time out on.
function fixedPause(tokens, spans, home, open, close, end) {
  const parts = [[]]
  for (let k = open + 1; k < close; k++) {
    if (tokens[k].type === 'punct' && tokens[k].value in OPENERS) { const to = closing(tokens, k); parts.at(-1).push(...tokens.slice(k, to + 1)); k = to; continue }
    if (tokens[k].value === ';') parts.push([]); else parts.at(-1).push(tokens[k])
  }
  if (parts.length !== 3) return false
  const [init, condition] = parts
  const counter = init[0]?.value === 'let' ? init[1]?.value : null
  if (!counter || condition.length !== 3 || condition[0].value !== counter || !['<', '<='].includes(condition[1].value) ||
    condition[1].type !== 'punct' || condition[2].type !== 'number') return false
  for (let k = close + 1; k <= end; k++) {
    if (['break', 'return', 'throw'].includes(tokens[k].value) && tokens[k].type === 'name' && innermost(spans, k) === home) return false
  }
  return true
}

function programDeadlines(tokens) {
  return tokens.filter(token => token.type === 'string' && CLOCK_IN_PROGRAM.test(token.value))
    .map(token => ({ line: token.line, rule: 'program-deadline', detail: 'an embedded program compares a clock reading' }))
}

// The local names bound to `until`, and to exported functions of support
// modules that wait.
function waitingImports(tokens, file, waitingExports) {
  const names = new Set()
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].value !== 'import' || tokens[k + 1]?.value !== '{') continue
    const close = closing(tokens, k + 1), from = tokens[close + 2]
    if (tokens[close + 1]?.value !== 'from' || from?.type !== 'string' || !from.value.startsWith('.')) continue
    const target = resolve(dirname(file), from.value)
    const exported = waitingExports.get(target) ?? (/(^|\/)support\/wait\.js$/.test(from.value) ? new Set(['until']) : new Set())
    for (let n = k + 2; n < close; n++) {
      if (tokens[n].type !== 'name' || tokens[n - 1]?.value === 'as') continue
      const local = tokens[n + 1]?.value === 'as' ? tokens[n + 2].value : tokens[n].value
      if (exported.has(tokens[n].value)) names.add(local)
    }
  }
  return names
}

// Functions that wait: their body calls a waiting name. Grows to a fixpoint.
// A method that waits counts at its member calls too, such as client.waitFor(t, ...).
function waitingFunctions(tokens, spans, seed) {
  const waiting = new Set(seed), named = [], methods = new Set()
  for (const [start, end] of spans) {
    let name = null
    if (tokens[start].value === 'function') name = tokens[start + 1]?.type === 'name' ? tokens[start + 1].value : null
    else if (tokens[start].value === '=>') {
      let k = start - 1
      if (tokens[k]?.value === ')') { let depth = 0; for (; k >= 0; k--) { if (tokens[k].value === ')') depth++; else if (tokens[k].value === '(' && --depth === 0) break } }
      k--; if (tokens[k]?.value === 'async') k--
      if (tokens[k]?.value === '=' && tokens[k - 1]?.type === 'name') name = tokens[k - 1].value
      else if (tokens[k]?.value === ':' && tokens[k - 1]?.type === 'name') name = tokens[k - 1].value
    } else { name = tokens[start].value; methods.add(name) }
    if (name) named.push({ name, start, end })
  }
  waiting.methods = new Set()
  for (let changed = true; changed;) {
    changed = false
    for (const { name, start, end } of named) {
      if (waiting.has(name)) continue
      if (callsAny(tokens, start, end, waiting)) {
        waiting.add(name); changed = true
        if (methods.has(name)) waiting.methods.add(name)
      }
    }
  }
  return waiting
}
function callsAny(tokens, start, end, names) {
  for (let k = start; k <= end; k++) {
    if (tokens[k].type !== 'name' || !names.has(tokens[k].value)) continue
    const member = tokens[k - 1]?.value === '.' || tokens[k - 1]?.value === '?.'
    if (member && !names.methods?.has(tokens[k].value)) continue
    if (tokens[k + 1]?.value === '(' || (!member && [',', ')'].includes(tokens[k + 1]?.value))) return true
  }
  return false
}

// A test or hook call's argument list as top-level spans.
function argumentsOf(tokens, open) {
  const close = closing(tokens, open), args = []
  let from = open + 1
  for (let k = open + 1; k < close; k++) {
    if (tokens[k].type === 'punct' && tokens[k].value in OPENERS) { k = closing(tokens, k); continue }
    if (tokens[k].value === ',') { args.push([from, k - 1]); from = k + 1 }
  }
  if (from < close) args.push([from, close - 1])
  return args
}
function declaresTimeout(tokens, [start, end]) {
  if (tokens[start].value !== '{' || closing(tokens, start) !== end) return false
  for (let k = start + 1; k < end; k++) {
    if (tokens[k].type === 'punct' && tokens[k].value in OPENERS) { k = closing(tokens, k); continue }
    if (tokens[k].value === 'timeout' && [':', ',', '}'].includes(tokens[k + 1]?.value) && [',', '{'].includes(tokens[k - 1]?.value)) return true
  }
  return false
}

function unboundedWaits(tokens, waiting) {
  const found = []
  for (let k = 0; k < tokens.length; k++) {
    const { type, value, line } = tokens[k]
    if (type !== 'name' || tokens[k + 1]?.value !== '(') continue
    const isTest = value === 'test' || value === 'it'
    const isHook = HOOKS.has(value)
    if (!isTest && !isHook) continue
    if (tokens[k - 1]?.value === '.' && !(tokens[k - 2]?.type === 'name')) continue
    if (['function', 'const', 'let', 'var'].includes(tokens[k - 1]?.value)) continue
    const args = argumentsOf(tokens, k + 1)
    const body = isTest ? args.at(-1) : args[0]
    if (!body) continue
    const options = isTest ? args.slice(0, -1).find(span => tokens[span[0]].value === '{') : args[1]
    const waits = callsAny(tokens, body[0], body[1], waiting) || (body[0] === body[1] && waiting.has(tokens[body[0]].value))
    if (waits && !(options && declaresTimeout(tokens, options))) {
      found.push({ line, rule: 'no-bound', detail: `${isTest ? 'a test' : `an ${value} hook`} waits without declaring its timeout` })
    }
  }
  return found
}

export function checkSource(source, { file = 'source.js', waitingExports = new Map() } = {}) {
  const tokens = tokenize(source), spans = functionSpans(tokens)
  const seed = waitingImports(tokens, file, waitingExports)
  const waiting = waitingFunctions(tokens, spans, seed)
  return {
    findings: [...pollingLoops(tokens, spans), ...programDeadlines(tokens), ...unboundedWaits(tokens, waiting)].sort((a, b) => a.line - b.line),
    waiting,
  }
}

// Every .js file under the test folder, support modules first so a test file
// knows which of their exports wait.
export function checkFolder(folder) {
  const helper = join(folder, 'support', 'wait.js'), teardown = join(folder, 'fixtures.js')
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.js') ? [join(directory, entry.name)] : [])
  const files = walk(folder).filter(file => file !== teardown).sort((a, b) => Number(a.endsWith('.test.js')) - Number(b.endsWith('.test.js')) || a.localeCompare(b))
  const waitingExports = new Map([[helper, new Set(['until'])]]), findings = []
  for (const file of files) {
    if (file === helper || file === fileURLToPath(import.meta.url)) continue
    let result
    try { result = checkSource(readFileSync(file, 'utf8'), { file, waitingExports }) } catch (error) {
      findings.push({ file, line: 0, rule: 'unreadable', detail: `the check cannot read this file: ${error.message}` }); continue
    }
    if (!file.endsWith('.test.js')) waitingExports.set(file, result.waiting)
    for (const finding of result.findings) findings.push({ file, ...finding })
  }
  return findings.map(finding => ({ ...finding, file: relative(folder, finding.file) }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const findings = checkFolder(folder)
  for (const { file, line, rule, detail } of findings) console.error(`${basename(folder)}/${file}:${line}: ${rule}: ${detail}`)
  if (findings.length) {
    console.error(`${findings.length} wait(s) keep a bound of their own; wait through until() in test/support/wait.js and declare the test's or hook's timeout`)
    process.exitCode = 1
  }
}
