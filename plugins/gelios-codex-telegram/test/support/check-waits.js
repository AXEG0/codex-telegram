#!/usr/bin/env node
// Refuses a test file that waits on a clock of its own. Every wait goes
// through `until` in test/support/wait.js, which ends when its check holds or
// when the bound of the test or hook running it ends. This check reports:
//   - a loop that polls: a `while`, `do` or counted `for` loop that sleeps on a
//     timer in its own function, or whose condition reads a clock;
//   - an embedded program (a string a test runs as code) that compares a clock
//     reading, the shape of a deadline written for another process;
//   - a test, `before` hook or cleanup() that waits through `until` without
//     declaring a `timeout`, since its bound is the only thing that ends a
//     wait that never holds;
//   - an `after` or `afterEach` hook that waits: node:test hands it the test's
//     signal, which has already aborted once the test's bound ended, and its
//     failure skips the hooks after it, so cleanups wait in cleanup();
//   - an 'exit' listener on anything but `process`: a listener added after a
//     child exited waits for an event that has already passed, so a wait on a
//     child's exit goes through exited(), which reads an exit already recorded;
//   - a wait that ends once a file exists, followed by a read of that file,
//     since a writer creates the file before it writes it.
// Names resolve through the file's bindings: imports in every form, aliases,
// namespaces, functions bound to members, and local names that shadow them.
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
const AFTER_HOOKS = new Set(['after', 'afterEach'])
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

// What the names in a file are bound to. Each name resolves through the
// scopes around it, innermost first, so a local function that shares a name
// with a waiting one elsewhere is not taken for it. Scopes are function
// bodies; the file is the outermost one.
const SLEEP_MODULES = /^(node:)?timers\/promises$/
const EVENT_MODULES = /^(node:)?events$/
function scopeAround(spans, index, own = null) {
  let best = null
  for (const span of spans) if (span !== own && span[0] < index && index <= span[1] && (!best || span[0] > best[0])) best = span
  return best
}
// The names a parameter list binds: names followed by `,`, `)`, `=`, `}` or
// `]`, not member names and not keys of a destructuring pattern.
function parameterNames(tokens, open, close) {
  const names = []
  for (let k = open + 1; k < close; k++) {
    const token = tokens[k]
    if (token.type !== 'name' || ['.', '?.'].includes(tokens[k - 1]?.value)) continue
    if ([',', ')', '=', '}', ']'].includes(tokens[k + 1]?.value) || k + 1 === close) names.push(token.value)
  }
  return names
}
function bindings(tokens, spans, file, exportsOf) {
  const scopes = new Map([[null, new Map()]]), methods = new Map(), byStart = new Map(spans.map(span => [span[0], span]))
  const scope = span => { if (!scopes.has(span)) scopes.set(span, new Map()); return scopes.get(span) }
  const declare = (span, name, binding) => { if (!scope(span).has(name)) scope(span).set(name, binding) }
  // A function value starting right at `index`: `function`, `async`, an
  // arrow's parameters or its single parameter.
  const functionAt = index => {
    let k = index
    if (tokens[k]?.value === 'async') k++
    if (tokens[k]?.value === 'function') return byStart.get(k) || null
    if (tokens[k]?.type === 'name' && tokens[k + 1]?.value === '=>') return byStart.get(k + 1) || null
    if (tokens[k]?.value === '(') { const close = closing(tokens, k); if (tokens[close + 1]?.value === '=>') return byStart.get(close + 1) || null }
    return null
  }
  for (const span of spans) {
    const k = span[0]
    if (tokens[k].value === 'function') {
      let open = k + 1
      while (tokens[open] && tokens[open].value !== '(') open++
      for (const name of parameterNames(tokens, open, closing(tokens, open))) declare(span, name, { kind: 'value' })
      if (tokens[k + 1]?.type === 'name' && tokens[k - 1]?.value !== '=' && tokens[k - 2]?.value !== '=') declare(scopeAround(spans, k, span), tokens[k + 1].value, { kind: 'function', body: span })
    } else if (tokens[k].value === '=>') {
      if (tokens[k - 1]?.value === ')') {
        let depth = 0, open = k - 1
        for (; open >= 0; open--) { if (tokens[open].value === ')') depth++; else if (tokens[open].value === '(' && --depth === 0) break }
        for (const name of parameterNames(tokens, open, k - 1)) declare(span, name, { kind: 'value' })
      } else if (tokens[k - 1]?.type === 'name') declare(span, tokens[k - 1].value, { kind: 'value' })
    } else {
      // A method in a class or an object literal: reached through member calls.
      for (const name of parameterNames(tokens, k + 1, closing(tokens, k + 1))) declare(span, name, { kind: 'value' })
      if (!methods.has(tokens[k].value)) methods.set(tokens[k].value, [])
      methods.get(tokens[k].value).push({ kind: 'function', body: span })
    }
  }
  for (let k = 0; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type === 'name' && ['const', 'let', 'var'].includes(value) && tokens[k + 1]?.type === 'name' && tokens[k + 2]?.value === '=') {
      const name = tokens[k + 1].value, body = functionAt(k + 3)
      const promisified = (tokens[k + 3]?.value === 'promisify' || (tokens[k + 4]?.value === '.' && tokens[k + 5]?.value === 'promisify')) &&
        tokens.slice(k + 3, k + 10).some(token => token.value === 'setTimeout' || token.value === 'setImmediate')
      const end = statementEnd(tokens, k + 3)
      const initializer = tokens.slice(k + 3, end + 1)
      const timerPromise = !body && initializer.length < 40 && initializer.some(token => token.value === 'Promise') && initializer.some(token => ['setTimeout', 'setImmediate'].includes(token.value))
      declare(scopeAround(spans, k), name, body ? { kind: 'function', body } : promisified || timerPromise ? { kind: 'sleeper' } : { kind: 'value' })
    } else if (type === 'name' && ['const', 'let', 'var'].includes(value) && ['{', '['].includes(tokens[k + 1]?.value)) {
      const close = closing(tokens, k + 1)
      for (const name of parameterNames(tokens, k + 1, close)) declare(scopeAround(spans, k), name, { kind: 'value' })
    } else if (type === 'punct' && value === '=' && tokens[k - 2]?.value === '.' && tokens[k - 1]?.type === 'name') {
      // obj.name = function value: reached through member calls.
      const body = functionAt(k + 1)
      if (body) { if (!methods.has(tokens[k - 1].value)) methods.set(tokens[k - 1].value, []); methods.get(tokens[k - 1].value).push({ kind: 'function', body }) }
    } else if (type === 'punct' && value === ':' && tokens[k - 1]?.type === 'name' && ['{', ','].includes(tokens[k - 2]?.value)) {
      // name: function value in an object literal: reached through member calls.
      const body = functionAt(k + 1)
      if (body) { if (!methods.has(tokens[k - 1].value)) methods.set(tokens[k - 1].value, []); methods.get(tokens[k - 1].value).push({ kind: 'function', body }) }
    } else if (type === 'name' && value === 'import' && tokens[k - 1]?.value !== '.' && tokens[k + 1]?.value !== '(') {
      let from = k + 1
      while (tokens[from] && !(tokens[from].value === 'from' && tokens[from + 1]?.type === 'string') && tokens[from].type !== 'string') from++
      const module = tokens[from]?.type === 'string' ? tokens[from].value : tokens[from + 1]?.value
      const target = module?.startsWith('.') ? resolve(dirname(file), module) : module
      for (let n = k + 1; n < from; n++) {
        const token = tokens[n]
        if (token.value === '{') {
          const close = closing(tokens, n)
          for (let m = n + 1; m < close; m++) {
            if (tokens[m].type !== 'name' || tokens[m - 1]?.value === 'as') continue
            const local = tokens[m + 1]?.value === 'as' ? tokens[m + 2].value : tokens[m].value
            declare(null, local, { kind: 'import', module: target, imported: tokens[m].value })
          }
          n = close
        } else if (token.value === '*' && tokens[n + 1]?.value === 'as') { declare(null, tokens[n + 2].value, { kind: 'namespace', module: target }); n += 2 }
        else if (token.type === 'name' && token.value !== 'from' && (tokens[n + 1]?.value === ',' || n + 1 === from)) declare(null, token.value, { kind: 'namespace', module: target, isDefault: true })
      }
    }
  }
  const lookup = (name, index) => {
    for (let span = scopeAround(spans, index); ; span = scopeAround(spans, span[0])) {
      const found = scope(span).get(name)
      if (found) return found
      if (span === null) return null
    }
  }
  const exported = (module, name) => exportsOf(module)?.has(name)
  return { lookup, methods, scopes, exported }
}

// The names of the calls and references that wait, sleep or listen, each
// resolved through the file's bindings.
function analyse(tokens, spans, file, waitingExports, sleepingExports) {
  const waitsOf = module => waitingExports.get(module) ?? (/(^|\/)support\/wait\.js$/.test(module || '') ? HELPER_WAITS : undefined)
  const model = bindings(tokens, spans, file, waitsOf)
  const waitingBodies = new Set(), sleepingBodies = new Set(), waitingMethods = new Set()
  const isWaitingBinding = binding => binding && ((binding.kind === 'function' && waitingBodies.has(binding.body)) ||
    (binding.kind === 'import' && waitsOf(binding.module)?.has(binding.imported)))
  const isSleepingBinding = binding => binding && (binding.kind === 'sleeper' || (binding.kind === 'function' && sleepingBodies.has(binding.body)) ||
    (binding.kind === 'import' && (SLEEP_MODULES.test(binding.module || '') ? ['setTimeout', 'setImmediate'].includes(binding.imported) : sleepingExports.get(binding.module)?.has(binding.imported))))
  // The binding a reference at `k` names: a bare name through the scopes, a
  // member of a namespace import through its module's exports, or a method.
  const refers = (k, test) => {
    const token = tokens[k]
    if (token.type !== 'name') return false
    const member = tokens[k - 1]?.value === '.' || tokens[k - 1]?.value === '?.'
    const called = tokens[k + 1]?.value === '(' || (!member && [',', ')'].includes(tokens[k + 1]?.value) && !['function', 'const', 'let', 'var', '.'].includes(tokens[k - 1]?.value))
    if (!called || (tokens[k + 1]?.value === '(' && ['function', 'const', 'let', 'var'].includes(tokens[k - 1]?.value))) return false
    if (!member) return test(model.lookup(token.value, k), token.value)
    const owner = tokens[k - 2]
    const namespace = owner?.type === 'name' && !['.', '?.'].includes(tokens[k - 3]?.value) ? model.lookup(owner.value, k - 2) : null
    if (namespace?.kind === 'namespace') return test({ kind: 'import', module: namespace.module, imported: token.value }, token.value)
    return test({ kind: 'method', name: token.value }, token.value)
  }
  const waitingRef = k => refers(k, binding => binding?.kind === 'method' ? waitingMethods.has(binding.name) : isWaitingBinding(binding))
  const sleepingRef = k => refers(k, binding => binding?.kind !== 'method' && isSleepingBinding(binding))
  const anyIn = (start, end, ref) => { for (let k = start; k <= end; k++) if (ref(k)) return true; return false }
  const functions = [...model.scopes.values()].flatMap(scope => [...scope.values()]).filter(binding => binding.kind === 'function')
  const methodBodies = [...model.methods.entries()].flatMap(([name, list]) => list.map(binding => ({ name, ...binding })))
  for (let changed = true; changed;) {
    changed = false
    for (const binding of functions) {
      if (!waitingBodies.has(binding.body) && anyIn(binding.body[0], binding.body[1], waitingRef)) { waitingBodies.add(binding.body); changed = true }
    }
    for (const binding of methodBodies) {
      if (!waitingMethods.has(binding.name) && anyIn(binding.body[0], binding.body[1], waitingRef)) { waitingMethods.add(binding.name); changed = true }
    }
  }
  // A short function whose body is a timer promise, or a call to one that
  // sleeps, sleeps itself.
  for (let changed = true; changed;) {
    changed = false
    for (const binding of functions) {
      if (sleepingBodies.has(binding.body)) continue
      const [start, end] = binding.body
      const body = tokens.slice(start, end + 1)
      if (body.length < 40 && ((body.some(token => token.value === 'Promise') && body.some(token => ['setTimeout', 'setImmediate'].includes(token.value))) ||
        anyIn(start + 1, end, sleepingRef))) { sleepingBodies.add(binding.body); changed = true }
    }
  }
  const topLevel = predicate => new Set([...model.scopes.get(null).entries()].filter(([, binding]) => predicate(binding)).map(([name]) => name))
  return {
    model, waitingRef, sleepingRef, anyIn,
    waiting: topLevel(isWaitingBinding),
    sleeping: topLevel(isSleepingBinding),
  }
}

// Token indexes where a sleep starts: a call to a sleeper, through its
// binding or a namespace import of its module, a short `new Promise(...)`
// around a timer, or a blocking Atomics.wait.
function sleeps(tokens, analysis) {
  const found = []
  for (let k = 0; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type !== 'name') continue
    if (analysis.sleepingRef(k) && tokens[k + 1]?.value === '(') { found.push(k); continue }
    if (tokens[k - 1]?.value === '.') continue
    if (value === 'new' && tokens[k + 1]?.value === 'Promise' && tokens[k + 2]?.value === '(') {
      const close = closing(tokens, k + 2)
      if (close - k < 40 && tokens.slice(k, close).some(token => ['setTimeout', 'setImmediate'].includes(token.value))) found.push(k)
    } else if ((value === 'Atomics' || value === 'scheduler') && tokens[k + 1]?.value === '.' && tokens[k + 2]?.value === 'wait') found.push(k)
  }
  return found
}

function pollingLoops(tokens, spans, analysis) {
  const sleeping = sleeps(tokens, analysis), found = [], doTails = new Set()
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
// counter with a number, and its body runs every step the same way, with no
// condition, early exit or skipped step. It paces a fixed number of steps,
// such as ticks before a check that nothing happened, and has no condition to
// time out on. A body that tests anything can skip its sleep once a state it
// reads holds, which makes the loop a poll.
const BRANCHES = new Set(['if', 'switch', 'break', 'continue', 'return', 'throw', 'while', 'do', '?', '&&', '||', '??', '?.', 'catch'])
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
    if (tokens[k].type !== 'string' && BRANCHES.has(tokens[k].value) && innermost(spans, k) === home) return false
  }
  return true
}

function programDeadlines(tokens) {
  return tokens.filter(token => token.type === 'string' && CLOCK_IN_PROGRAM.test(token.value))
    .map(token => ({ line: token.line, rule: 'program-deadline', detail: 'an embedded program compares a clock reading' }))
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

const TEST_NAMES = new Set(['test', 'it'])
const TEST_MODIFIERS = new Set(['only', 'skip', 'todo'])
function unboundedWaits(tokens, analysis) {
  const found = []
  for (let k = 0; k < tokens.length; k++) {
    const { type, value, line } = tokens[k]
    if (type !== 'name' || tokens[k + 1]?.value !== '(') continue
    const modified = TEST_MODIFIERS.has(value) && tokens[k - 1]?.value === '.' && TEST_NAMES.has(tokens[k - 2]?.value) && tokens[k - 3]?.value !== '.'
    const isTest = (TEST_NAMES.has(value) && !['.', '?.'].includes(tokens[k - 1]?.value)) || modified || (value === 'test' && tokens[k - 1]?.value === '.' && tokens[k - 2]?.type === 'name')
    const isHook = HOOKS.has(value) && (!['.', '?.'].includes(tokens[k - 1]?.value) || tokens[k - 2]?.type === 'name')
    const isCleanup = value === 'cleanup' && !['.', '?.'].includes(tokens[k - 1]?.value)
    if (!isTest && !isHook && !isCleanup) continue
    if (['function', 'const', 'let', 'var'].includes(tokens[k - 1]?.value)) continue
    const args = argumentsOf(tokens, k + 1)
    const body = isTest ? args.at(-1) : isCleanup ? args[2] : args[0]
    if (!body) continue
    const options = isTest ? args.slice(0, -1).find(span => tokens[span[0]].value === '{') : isCleanup ? args[3] : args[1]
    const waits = analysis.anyIn(body[0], body[1], analysis.waitingRef)
    const name = modified ? `${tokens[k - 2].value}.${value}` : value
    if (waits && isHook) {
      found.push({ line, rule: 'hook-wait', detail: `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name} hook waits on a context its own timeout does not end, so the wait can outlive it; wait after a test in cleanup(), and before one in the test itself` })
    } else if (waits && !(options && declaresTimeout(tokens, options))) {
      found.push({ line, rule: 'no-bound', detail: `${isTest ? (modified ? `a ${name} test` : 'a test') : 'a cleanup'} waits without declaring its timeout` })
    }
  }
  return found
}

// An 'exit' listener: emitter.on/once/addListener/prepend...('exit'), and the
// function form events.once(emitter, 'exit') however node:events is imported.
const LISTENERS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'])
function exitListeners(tokens, analysis) {
  const found = []
  const isEventsOnce = (binding, name) => binding && ((binding.kind === 'import' && EVENT_MODULES.test(binding.module || '') && binding.imported === 'once') ||
    (binding.kind === 'namespace' && EVENT_MODULES.test(binding.module || '')))
  for (let k = 0; k < tokens.length; k++) {
    const { type, value, line } = tokens[k]
    if (type !== 'name' || tokens[k + 1]?.value !== '(') continue
    const member = tokens[k - 1]?.value === '.' || tokens[k - 1]?.value === '?.'
    let event
    const args = argumentsOf(tokens, k + 1)
    const ownerBinding = member && tokens[k - 2]?.type === 'name' && !['.', '?.'].includes(tokens[k - 3]?.value) ? analysis.model.lookup(tokens[k - 2].value, k - 2) : null
    const functionForm = member ? value === 'once' && (isEventsOnce(ownerBinding) || (ownerBinding?.kind === 'import' && EVENT_MODULES.test(ownerBinding.module || '') && ownerBinding.imported === 'EventEmitter'))
      : isEventsOnce(analysis.model.lookup(value, k))
    if (functionForm) {
      if (args.length < 2 || (args[0][0] === args[0][1] && tokens[args[0][0]].value === 'process')) continue
      event = tokens[args[1][0]]
    } else if (member && LISTENERS.has(value)) {
      if (tokens[k - 2]?.value === 'process' && !['.', '?.'].includes(tokens[k - 3]?.value)) continue
      event = tokens[k + 2]
    } else continue
    if (event?.type === 'string' && event.value === 'exit') {
      found.push({ line, rule: 'exit-listener', detail: "an 'exit' listener added after the child may have exited waits for an event that has passed; wait through exited()" })
    }
  }
  return found
}

// A wait that ends once a file exists, followed by a read of that file: a
// writer creates a file before it writes it, so the read can find it empty.
// The wait reads the content it needs instead.
function existsThenRead(tokens, analysis) {
  const found = [], text = (start, end) => tokens.slice(start, end + 1).map(token => `${token.type}:${token.value}`).join(' ')
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k + 1]?.value !== '(' || !analysis.waitingRef(k)) continue
    const close = closing(tokens, k + 1)
    const call = tokens.slice(k + 2, close)
    if (call.some(token => token.value === 'readFileSync')) continue
    for (let j = k + 2; j < close; j++) {
      if (tokens[j].value !== 'existsSync' || tokens[j + 1]?.value !== '(') continue
      const path = text(j + 2, closing(tokens, j + 1) - 1)
      for (let n = close + 1; n < Math.min(tokens.length, close + 80); n++) {
        if (tokens[n].value === 'readFileSync' && tokens[n + 1]?.value === '(' && text(n + 2, n + 1 + (closing(tokens, j + 1) - j - 2)) === path) {
          found.push({ line: tokens[k].line, rule: 'exists-then-read', detail: 'a wait ends once a file exists and the file is then read; a writer creates the file before it writes it, so the wait reads the content instead' })
          n = tokens.length; j = close
        }
      }
    }
  }
  return found
}

export function checkSource(source, { file = 'source.js', waitingExports = new Map(), sleepingExports = new Map() } = {}) {
  const tokens = tokenize(source), spans = functionSpans(tokens)
  const analysis = analyse(tokens, spans, file, waitingExports, sleepingExports)
  return {
    findings: [...pollingLoops(tokens, spans, analysis), ...programDeadlines(tokens), ...unboundedWaits(tokens, analysis), ...exitListeners(tokens, analysis), ...existsThenRead(tokens, analysis)].sort((a, b) => a.line - b.line),
    waiting: analysis.waiting,
    sleeping: analysis.sleeping,
  }
}

// The waits test/support/wait.js exports: each ends at the bound of the
// context it is given.
export const HELPER_WAITS = new Set(['until', 'exited', 'closed'])

// Every .js file under the test folder, support modules first so a test file
// knows which of their exports wait or sleep.
export function checkFolder(folder) {
  const helper = join(folder, 'support', 'wait.js'), teardown = join(folder, 'fixtures.js')
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.js') ? [join(directory, entry.name)] : [])
  const files = walk(folder).filter(file => file !== teardown).sort((a, b) => Number(a.endsWith('.test.js')) - Number(b.endsWith('.test.js')) || a.localeCompare(b))
  const waitingExports = new Map([[helper, HELPER_WAITS]]), sleepingExports = new Map(), findings = []
  for (const file of files) {
    if (file === helper || file === fileURLToPath(import.meta.url)) continue
    let result
    try { result = checkSource(readFileSync(file, 'utf8'), { file, waitingExports, sleepingExports }) } catch (error) {
      findings.push({ file, line: 0, rule: 'unreadable', detail: `the check cannot read this file: ${error.message}` }); continue
    }
    if (!file.endsWith('.test.js')) { waitingExports.set(file, result.waiting); sleepingExports.set(file, result.sleeping) }
    for (const finding of result.findings) findings.push({ file, ...finding })
  }
  return findings.map(finding => ({ ...finding, file: relative(folder, finding.file) }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const findings = checkFolder(folder)
  for (const { file, line, rule, detail } of findings) console.error(`${basename(folder)}/${file}:${line}: ${rule}: ${detail}`)
  if (findings.length) {
    console.error(`${findings.length} wait(s) keep a bound of their own; wait through until() in test/support/wait.js, declare the test's timeout, wait after a test in cleanup(), and on a child's exit through exited()`)
    process.exitCode = 1
  }
}
