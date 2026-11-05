#!/usr/bin/env node
// Refuses a test file that waits on a clock of its own. Every wait goes
// through `until` in test/support/wait.js, which ends when its check holds or
// when the bound of the context it is given ends. This check is a diagnostic:
// it reads code, so it bounds nothing. What bounds every wait is what runs the
// test file: each test's own timeout, and test/support/run-tests.js, which has
// node:test end each file at a bound of its own and once its tests are done.
// The check reports:
//   - a loop that polls: a `while`, `do` or counted `for` loop that sleeps on a
//     timer in its own function, or whose condition reads a clock, and a poll
//     on an interval or by recursion;
//   - an embedded program (a string a test runs as code) that compares a clock
//     reading, the shape of a deadline written for another process;
//   - an 'exit' listener on anything but `process`, and a late 'close' listener
//     on a child: a listener added after a child exited waits for an event that
//     has already passed, so a wait on a child goes through exited() or closed();
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
  const scopes = new Map([[null, new Map()]]), methods = new Map(), byStart = new Map(spans.map(span => [span[0], span])), deferred = []
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
      for (const name of parameterNames(tokens, open, closing(tokens, open))) declare(span, name, { kind: 'value', parameter: true })
      if (tokens[k + 1]?.type === 'name' && tokens[k - 1]?.value !== '=' && tokens[k - 2]?.value !== '=') declare(scopeAround(spans, k, span), tokens[k + 1].value, { kind: 'function', body: span })
    } else if (tokens[k].value === '=>') {
      if (tokens[k - 1]?.value === ')') {
        let depth = 0, open = k - 1
        for (; open >= 0; open--) { if (tokens[open].value === ')') depth++; else if (tokens[open].value === '(' && --depth === 0) break }
        for (const name of parameterNames(tokens, open, k - 1)) declare(span, name, { kind: 'value', parameter: true })
      } else if (tokens[k - 1]?.type === 'name') declare(span, tokens[k - 1].value, { kind: 'value', parameter: true })
    } else {
      // A method in a class or an object literal: reached through member calls.
      for (const name of parameterNames(tokens, k + 1, closing(tokens, k + 1))) declare(span, name, { kind: 'value', parameter: true })
      if (!methods.has(tokens[k].value)) methods.set(tokens[k].value, [])
      methods.get(tokens[k].value).push({ kind: 'function', body: span })
    }
  }
  for (let k = 0; k < tokens.length; k++) {
    const { type, value } = tokens[k]
    if (type === 'name' && ['const', 'let', 'var'].includes(value) && tokens[k + 1]?.type === 'name' && tokens[k + 2]?.value === '=') {
      // Each declarator of const a = 1, b = a * 2 binds its own name.
      for (let d = k + 1; tokens[d]?.type === 'name' && tokens[d + 1]?.value === '=';) {
        const name = tokens[d].value, at = d + 2, body = functionAt(at)
        const promisified = (tokens[at]?.value === 'promisify' || (tokens[at + 1]?.value === '.' && tokens[at + 2]?.value === 'promisify')) &&
          tokens.slice(at, at + 7).some(token => token.value === 'setTimeout' || token.value === 'setImmediate')
        const end = statementEnd(tokens, at, true)
        const initializer = tokens.slice(at, end + 1)
        const timerPromise = !body && initializer.length < 40 && initializer.some(token => token.value === 'Promise') && initializer.some(token => ['setTimeout', 'setImmediate'].includes(token.value))
        declare(scopeAround(spans, k), name, body ? { kind: 'function', body } : promisified || timerPromise ? { kind: 'sleeper' } : { kind: 'value', constant: value === 'const', init: [at, end], literal: value === 'const' && at === end && tokens[at].type === 'string' ? tokens[at].value : undefined })
        if (tokens[end + 1]?.value !== ',') break
        d = end + 2
      }
    } else if (type === 'name' && ['let', 'var'].includes(value) && tokens[k + 1]?.type === 'name' && tokens[k + 2]?.value !== '=' && tokens[k - 1]?.value !== '.') {
      // let x without a value: assigned later.
      declare(scopeAround(spans, k), tokens[k + 1].value, { kind: 'value' })
    } else if (type === 'name' && ['const', 'let', 'var'].includes(value) && ['{', '['].includes(tokens[k + 1]?.value)) {
      const close = closing(tokens, k + 1)
      // const { a: b } = ns, or = await import('module'): b is that module's export a.
      let from = close + 2
      if (tokens[from]?.value === 'await') from++
      const dynamic = tokens[from]?.value === 'import' && tokens[from + 1]?.value === '(' && tokens[from + 2]?.type === 'string' ? tokens[from + 2].value : null
      const source = dynamic !== null ? { module: dynamic.startsWith('.') ? resolve(dirname(file), dynamic) : dynamic }
        : tokens[from]?.type === 'name' && tokens[from + 1]?.value !== '.' && tokens[from + 1]?.value !== '(' ? { name: tokens[from].value, at: from } : null
      if (tokens[close + 1]?.value === '=' && tokens[k + 1].value === '{' && source) {
        for (let m = k + 2; m < close; m++) {
          if (tokens[m].type !== 'name' || [':', '.'].includes(tokens[m - 1]?.value)) continue
          const local = tokens[m + 1]?.value === ':' ? tokens[m + 2]?.value : tokens[m].value
          if (!local) continue
          const imported = tokens[m].value, home = scopeAround(spans, k)
          if (source.module) declare(home, local, { kind: 'import', module: source.module, imported })
          else deferred.push({ name: source.name, at: source.at, scope: home, local, imported })
          if (tokens[m + 1]?.value === ':') m += 2
        }
      } else for (const name of parameterNames(tokens, k + 1, close)) declare(scopeAround(spans, k), name, { kind: 'value' })
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
  // const { a: b } = ns binds b as ns's module export a once every import is known.
  for (const pending of deferred) {
    const found = lookup(pending.name, pending.at)
    declare(pending.scope, pending.local, found?.kind === 'namespace' ? { kind: 'import', module: found.module, imported: pending.imported } : { kind: 'value' })
  }
  function lookup(name, index) {
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
  const waitingBodies = new Set(), sleepingBodies = new Set(), waitingMethods = new Set(), sleepingMethods = new Set()
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
  const sleepingRef = k => refers(k, binding => binding?.kind === 'method' ? sleepingMethods.has(binding.name) : isSleepingBinding(binding))
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
  const sleepsItself = ([start, end]) => {
    const body = tokens.slice(start, end + 1)
    return body.length < 40 && ((body.some(token => token.value === 'Promise') && body.some(token => ['setTimeout', 'setImmediate'].includes(token.value))) ||
      anyIn(start + 1, end, sleepingRef))
  }
  for (let changed = true; changed;) {
    changed = false
    for (const binding of functions) {
      if (!sleepingBodies.has(binding.body) && sleepsItself(binding.body)) { sleepingBodies.add(binding.body); changed = true }
    }
    // A method of an object or a class that sleeps: reached through member calls.
    for (const binding of methodBodies) {
      if (!sleepingMethods.has(binding.name) && sleepsItself(binding.body)) { sleepingMethods.add(binding.name); changed = true }
    }
  }
  const topLevel = predicate => new Set([...model.scopes.get(null).entries()].filter(([, binding]) => predicate(binding)).map(([name]) => name))
  const helperWaitRef = k => refers(k, binding => binding?.kind === 'import' && /(^|\/)support\/wait\.js$/.test(binding.module || '') && HELPER_WAITS.has(binding.imported))
  return {
    model, waitingRef, sleepingRef, helperWaitRef, anyIn,
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
// An 'exit' listener: emitter.on/once/addListener/prepend...('exit'), and the
// function form events.once(emitter, 'exit') however node:events is imported.
const LISTENERS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'])
// The calls that start a process, each resolved through the file's bindings:
// node:child_process's spawn, fork, exec and execFile in any import form, the
// starters test/fixtures.js exports, a local function that returns what one of
// them starts, and such a function another module of the test folder exports.
const STARTERS = new Set(['spawn', 'fork', 'exec', 'execFile'])
const CHILD_MODULES = /^(node:)?child_process$/
const FIXTURES = /(^|\/)fixtures\.js$/
function processStarts(tokens, spans, analysis) {
  const startingBodies = new Set()
  const isStarter = binding => binding && ((binding.kind === 'import' && (CHILD_MODULES.test(binding.module || '') || FIXTURES.test(binding.module || '')) && STARTERS.has(binding.imported)) ||
    (binding.kind === 'import' && analysis.startingExports.get(binding.module)?.has(binding.imported)) ||
    (binding.kind === 'function' && startingBodies.has(binding.body)))
  // The call that starts at `k`, a name or a namespace member, starts a process.
  const startsAt = k => {
    if (tokens[k]?.value === 'await') k++
    if (tokens[k]?.type !== 'name') return false
    if (tokens[k + 1]?.value === '(') return isStarter(analysis.model.lookup(tokens[k].value, k))
    if (tokens[k + 1]?.value === '.' && tokens[k + 2]?.type === 'name' && tokens[k + 3]?.value === '(') {
      const namespace = analysis.model.lookup(tokens[k].value, k)
      return namespace?.kind === 'namespace' && (((CHILD_MODULES.test(namespace.module || '') || FIXTURES.test(namespace.module || '')) && STARTERS.has(tokens[k + 2].value)) ||
        Boolean(analysis.startingExports.get(namespace.module)?.has(tokens[k + 2].value)))
    }
    return false
  }
  const functions = [...analysis.model.scopes.values()].flatMap(scope => [...scope.values()]).filter(binding => binding.kind === 'function')
  for (let changed = true; changed;) {
    changed = false
    for (const binding of functions) {
      if (startingBodies.has(binding.body)) continue
      const [start, end] = binding.body
      const arrow = tokens[start].value === '=>' && tokens[start + 1]?.value !== '{'
      let returns = arrow && startsAt(start + 1)
      for (let k = start; !returns && k <= end; k++) if (tokens[k].value === 'return' && innermost(spans, k) === binding.body && startsAt(k + 1)) returns = true
      if (returns) { startingBodies.add(binding.body); changed = true }
    }
  }
  // Where the value a name holds at `at` was started: its initializer, or the
  // last assignment before `at`, when that is a starter's call.
  const starts = new Map()
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].type !== 'name' || tokens[k + 1]?.value !== '=' || ['.', '?.'].includes(tokens[k - 1]?.value)) continue
    const binding = analysis.model.lookup(tokens[k].value, k)
    if (!binding || !startsAt(k + 2)) continue
    if (!starts.has(binding)) starts.set(binding, [])
    starts.get(binding).push([k + 2, statementEnd(tokens, k + 2)])
  }
  const childStart = (index, at) => {
    const binding = tokens[index]?.type === 'name' ? analysis.model.lookup(tokens[index].value, index) : null
    if (!binding) return null
    const list = [...(binding.init && startsAt(binding.init[0]) ? [binding.init] : []), ...(starts.get(binding) || [])].filter(([from]) => from < at)
    return list.sort((a, b) => b[0] - a[0])[0] ?? null
  }
  // The file's top-level functions that return a started child, for the files that import them.
  childStart.starting = new Set([...analysis.model.scopes.get(null).entries()].filter(([, binding]) => binding.kind === 'function' && startingBodies.has(binding.body)).map(([name]) => name))
  return childStart
}
function exitListeners(tokens, spans, analysis) {
  const found = []
  const childStart = analysis.childStart
  // A listener is late when it is added in another function than the one that
  // started the child, or after an await there: the child may have closed.
  const executors = []
  for (let n = 0; n < tokens.length; n++) if (tokens[n].value === 'new' && tokens[n + 1]?.value === 'Promise' && tokens[n + 2]?.value === '(') executors.push(n)
  const runsAt = index => {
    let span = innermost(spans, index)
    for (let made; span && (made = executors.find(n => n + 2 < span[0] && span[0] <= (argumentsOf(tokens, n + 2)[0]?.[1] ?? -1))) !== undefined;) span = innermost(spans, made)
    return span
  }
  const late = (start, k) => {
    const home = runsAt(start[0])
    if (runsAt(k) !== home) return true
    for (let n = start[1] + 1; n < k; n++) if (tokens[n].value === 'await' && runsAt(n) === home) return true
    return false
  }
  const isEventsOnce = (binding, name) => binding && ((binding.kind === 'import' && EVENT_MODULES.test(binding.module || '') && binding.imported === 'once') ||
    (binding.kind === 'namespace' && EVENT_MODULES.test(binding.module || '')))
  // The event an argument names: a string, or a const holding one. Anything
  // else is unknown to the check.
  const eventOf = ([start, end] = []) => {
    if (start === undefined || start !== end) return undefined
    if (tokens[start].type === 'string') return tokens[start].value
    return tokens[start].type === 'name' ? analysis.model.lookup(tokens[start].value, start)?.literal : undefined
  }
  for (let k = 0; k < tokens.length; k++) {
    const { type, line } = tokens[k]
    // name(...), name?.(...), and a member read by its string, ['name'](...).
    let value, open, member
    if (type === 'name') { value = tokens[k].value; open = k + 1; member = ['.', '?.'].includes(tokens[k - 1]?.value) }
    else if (type === 'string' && tokens[k - 1]?.value === '[' && tokens[k + 1]?.value === ']' && tokens[k - 2]?.type === 'name') { value = tokens[k].value; open = k + 2; member = true }
    else continue
    if (tokens[open]?.value === '?.') open++
    if (tokens[open]?.value !== '(') continue
    let event
    const args = argumentsOf(tokens, open)
    const ownerBinding = member && tokens[k - 2]?.type === 'name' && !['.', '?.'].includes(tokens[k - 3]?.value) ? analysis.model.lookup(tokens[k - 2].value, k - 2) : null
    const functionForm = member ? value === 'once' && (isEventsOnce(ownerBinding) || (ownerBinding?.kind === 'import' && EVENT_MODULES.test(ownerBinding.module || '') && ownerBinding.imported === 'EventEmitter'))
      // an unbound once is read as node:events' own, since the check cannot tell
      : isEventsOnce(analysis.model.lookup(value, k)) || (value === 'once' && !analysis.model.lookup(value, k))
    if (functionForm) {
      if (args.length < 2 || (args[0][0] === args[0][1] && tokens[args[0][0]].value === 'process')) continue
      event = args[1]
    } else if (member && LISTENERS.has(value)) {
      if (tokens[k - 2]?.value === 'process' && !['.', '?.'].includes(tokens[k - 3]?.value)) continue
      event = args[0]
    } else continue
    const name = eventOf(event)
    // The emitter: the first argument of node:events' once, else the member's owner.
    const ownerAt = functionForm ? (args[0][0] === args[0][1] ? args[0][0] : -1) : k - 2
    const start = ownerAt >= 0 ? childStart(ownerAt, k) : null
    // A name nothing binds may be a child the check cannot see.
    const unbound = functionForm && ownerAt >= 0 && tokens[ownerAt].type === 'name' && tokens[ownerAt].value !== 'this' && !analysis.model.lookup(tokens[ownerAt].value, ownerAt)
    if (name === 'close') {
      if ((start && late(start, k)) || unbound) {
        found.push({ line, rule: 'close-listener', detail: "a 'close' listener added after the child may have closed waits for an event that has passed; wait through closed()" })
      }
    } else if (name === 'exit') {
      found.push({ line, rule: 'exit-listener', detail: "an 'exit' listener added after the child may have exited waits for an event that has passed; wait through exited()" })
    } else if (name === undefined && (start || unbound)) {
      found.push({ line, rule: 'exit-listener', detail: 'a listener on a child whose event the check cannot read: name it with a string, or a const holding one' })
    }
  }
  return found
}

// A wait that ends once a file exists, followed by a read of that file: a
// writer creates a file before it writes it, so the read can find it empty.
// The wait reads the content it needs instead.
const READERS = new Set(['readFileSync', 'readFile', 'createReadStream'])
function existsThenRead(tokens, spans, analysis) {
  const found = [], text = (start, end) => tokens.slice(start, end + 1).map(token => `${token.type}:${token.value}`).join(' ')
  // A path argument, through a const that holds it.
  const pathOf = ([start, end]) => {
    const binding = start === end && tokens[start].type === 'name' ? analysis.model.lookup(tokens[start].value, start) : null
    return binding?.kind === 'value' && binding.constant ? text(...binding.init) : text(start, end)
  }
  // The paths read between two tokens, following calls into this file's
  // functions and methods.
  const readsIn = (start, end, seen = new Set()) => {
    const paths = []
    for (let n = start; n <= end; n++) {
      if (tokens[n].type !== 'name' || tokens[n + 1]?.value !== '(') continue
      if (READERS.has(tokens[n].value)) { const [first] = argumentsOf(tokens, n + 1); if (first) paths.push(pathOf(first)); continue }
      const member = ['.', '?.'].includes(tokens[n - 1]?.value)
      const binding = member ? null : analysis.model.lookup(tokens[n].value, n)
      const bodies = binding?.kind === 'function' ? [binding.body] : member ? (analysis.model.methods.get(tokens[n].value) || []).map(method => method.body) : []
      for (const body of bodies) if (!seen.has(body)) { seen.add(body); paths.push(...readsIn(body[0], body[1], seen)) }
    }
    return paths
  }
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k + 1]?.value !== '(' || !analysis.waitingRef(k)) continue
    const close = closing(tokens, k + 1)
    if (readsIn(k + 2, close - 1).length) continue
    const after = readsIn(close + 1, innermost(spans, k)?.[1] ?? tokens.length - 1)
    for (let j = k + 2; j < close; j++) {
      if (tokens[j].value !== 'existsSync' || tokens[j + 1]?.value !== '(') continue
      const [path] = argumentsOf(tokens, j + 1)
      if (path && after.includes(pathOf(path))) {
        found.push({ line: tokens[k].line, rule: 'exists-then-read', detail: 'a wait ends once a file exists and the file is then read; a writer creates the file before it writes it, so the wait reads the content instead' })
        break
      }
    }
  }
  return found
}

// A poll on an interval: a setInterval whose callback settles a promise, by a
// promise executor's resolve or reject or a name that holds one, or clears its
// own interval, ends on a condition on a clock of its own. So does a for await
// over node:timers/promises' setInterval, called there or held in a const.
function intervalPolls(tokens, spans, analysis) {
  const found = [], settlers = new Set()
  // A promise executor's parameters settle its promise.
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].value !== 'new' || tokens[k + 1]?.value !== 'Promise' || tokens[k + 2]?.value !== '(') continue
    const [executor] = argumentsOf(tokens, k + 2)
    const span = executor && spans.filter(candidate => candidate[0] >= executor[0] && candidate[1] === executor[1]).sort((a, b) => a[0] - b[0])[0]
    for (const binding of analysis.model.scopes.get(span)?.values() || []) if (binding.parameter) settlers.add(binding)
  }
  // A name assigned a settler holds one.
  for (let changed = true; changed;) {
    changed = false
    for (let k = 0; k < tokens.length; k++) {
      if (tokens[k].type !== 'name' || tokens[k + 1]?.value !== '=' || tokens[k + 2]?.type !== 'name' || ![';', ',', ')', '}'].includes(tokens[k + 3]?.value ?? ';')) continue
      const from = analysis.model.lookup(tokens[k + 2].value, k + 2), to = analysis.model.lookup(tokens[k].value, k)
      if (from && to && settlers.has(from) && !settlers.has(to)) { settlers.add(to); changed = true }
    }
    for (const scope of analysis.model.scopes.values()) for (const binding of scope.values()) {
      if (binding.kind === 'value' && binding.init && binding.init[0] === binding.init[1] && tokens[binding.init[0]].type === 'name' && settlers.has(analysis.model.lookup(tokens[binding.init[0]].value, binding.init[0])) && !settlers.has(binding)) { settlers.add(binding); changed = true }
    }
  }
  const isInterval = k => {
    if (tokens[k].type !== 'name' || tokens[k + 1]?.value !== '(') return false
    if (!['.', '?.'].includes(tokens[k - 1]?.value)) {
      const binding = analysis.model.lookup(tokens[k].value, k)
      return binding ? binding.kind === 'import' && /^(node:)?timers(\/promises)?$/.test(binding.module || '') && binding.imported === 'setInterval' : tokens[k].value === 'setInterval'
    }
    if (tokens[k].value !== 'setInterval') return false
    const owner = tokens[k - 2], binding = owner?.type === 'name' ? analysis.model.lookup(owner.value, k - 2) : null
    return ['globalThis', 'timers'].includes(owner?.value) && !binding || (binding?.kind === 'namespace' && /^(node:)?timers(\/promises)?$/.test(binding.module || ''))
  }
  const settles = ([start, end]) => {
    for (let n = start; n <= end; n++) {
      if (tokens[n].type !== 'name' || tokens[n + 1]?.value !== '(' || ['.', '?.'].includes(tokens[n - 1]?.value)) continue
      if (tokens[n].value === 'clearInterval' && !analysis.model.lookup('clearInterval', n)) return true
      if (settlers.has(analysis.model.lookup(tokens[n].value, n))) return true
    }
    return false
  }
  for (let k = 0; k < tokens.length; k++) {
    // for await (... of EXPR), EXPR an interval or a const holding one
    if (tokens[k].value === 'of' && tokens[k - 1]?.type === 'name') {
      let head = k
      while (head > 0 && tokens[head].value !== '(') head--
      if (tokens[head - 1]?.value !== 'await' || tokens[head - 2]?.value !== 'for') continue
      const close = closing(tokens, head)
      let at = k + 1
      if (tokens[at]?.type === 'name' && close === at + 1) {
        const binding = analysis.model.lookup(tokens[at].value, at)
        if (binding?.kind === 'value' && binding.init) at = binding.init[0]
      }
      while (tokens[at]?.type === 'name' && tokens[at + 1]?.value === '.' && tokens[at + 3]?.value === '(') at += 2
      if (isInterval(at)) found.push({ line: tokens[k].line, rule: 'poll', detail: 'a loop over an interval polls on a clock of its own' })
      continue
    }
    if (!isInterval(k) || tokens[k - 1]?.value === 'of') continue
    const [callback] = argumentsOf(tokens, k + 1)
    if (!callback) continue
    let body = callback
    if (callback[0] === callback[1] && tokens[callback[0]].type === 'name') {
      const binding = analysis.model.lookup(tokens[callback[0]].value, callback[0])
      body = binding?.kind === 'function' ? binding.body : null
    }
    if (body && settles(body)) found.push({ line: tokens[k].line, rule: 'poll', detail: 'a setInterval that waits for a condition polls on a clock of its own' })
  }
  return found
}

// A cycle of calls, a function calling itself or calling one that calls it
// back, directly, through a method or through a timer it schedules, polls as a
// loop does when a function on it sleeps or schedules a timer.
function recursivePolls(tokens, spans, analysis) {
  const found = []
  const sleeping = new Set(sleeps(tokens, analysis))
  const TIMERS = new Set(['setTimeout', 'setImmediate', 'setInterval'])
  const nodes = [...new Set([...analysis.model.scopes.values()].flatMap(scope => [...scope.values()]).filter(binding => binding.kind === 'function').map(binding => binding.body)
    .concat([...analysis.model.methods.values()].flat().map(binding => binding.body)))]
  const edges = new Map(), pauses = new Set()
  for (const body of nodes) {
    const next = new Set()
    for (let k = body[0]; k <= body[1]; k++) {
      const token = tokens[k]
      if (sleeping.has(k)) pauses.add(body)
      if (token.type !== 'name') continue
      const member = ['.', '?.'].includes(tokens[k - 1]?.value)
      if (!member && TIMERS.has(token.value) && tokens[k + 1]?.value === '(' && !analysis.model.lookup(token.value, k)) pauses.add(body)
      // a call, or a function handed to a timer
      const called = tokens[k + 1]?.value === '(' || (tokens[k - 1]?.value === '(' && TIMERS.has(tokens[k - 2]?.value))
      if (!called) continue
      if (member) { for (const method of analysis.model.methods.get(token.value) || []) next.add(method.body); continue }
      const binding = analysis.model.lookup(token.value, k)
      if (binding?.kind === 'function' && !(tokens[k - 1]?.value === 'function')) next.add(binding.body)
    }
    edges.set(body, next)
  }
  // Tarjan's strongly connected components over the call graph.
  let index = 0
  const order = new Map(), low = new Map(), stack = [], onStack = new Set()
  const visit = body => {
    order.set(body, index); low.set(body, index); index++; stack.push(body); onStack.add(body)
    for (const next of edges.get(body) || []) {
      if (!order.has(next)) { visit(next); low.set(body, Math.min(low.get(body), low.get(next))) }
      else if (onStack.has(next)) low.set(body, Math.min(low.get(body), order.get(next)))
    }
    if (low.get(body) !== order.get(body)) return
    const component = []
    for (let member; member !== body;) { member = stack.pop(); onStack.delete(member); component.push(member) }
    const cycle = component.length > 1 || edges.get(body)?.has(body)
    if (cycle && component.some(member => pauses.has(member))) {
      const first = component.sort((a, b) => a[0] - b[0])[0]
      found.push({ line: tokens[first[0]].line, rule: 'poll', detail: 'a function that sleeps or schedules a timer calls itself again, a poll on a clock of its own' })
    }
  }
  for (const body of nodes) if (!order.has(body)) visit(body)
  return found
}

export function checkSource(source, { file = 'source.js', waitingExports = new Map(), sleepingExports = new Map(), startingExports = new Map() } = {}) {
  const tokens = tokenize(source), spans = functionSpans(tokens)
  const analysis = analyse(tokens, spans, file, waitingExports, sleepingExports)
  analysis.startingExports = startingExports
  analysis.childStart = processStarts(tokens, spans, analysis)
  return {
    findings: [...pollingLoops(tokens, spans, analysis), ...programDeadlines(tokens), ...exitListeners(tokens, spans, analysis), ...existsThenRead(tokens, spans, analysis), ...intervalPolls(tokens, spans, analysis), ...recursivePolls(tokens, spans, analysis)].sort((a, b) => a.line - b.line),
    waiting: analysis.waiting,
    sleeping: analysis.sleeping,
    starting: analysis.childStart.starting,
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
  const waitingExports = new Map([[helper, HELPER_WAITS]]), sleepingExports = new Map(), startingExports = new Map(), findings = []
  for (const file of files) {
    if (file === helper || file === fileURLToPath(import.meta.url)) continue
    let result
    try { result = checkSource(readFileSync(file, 'utf8'), { file, waitingExports, sleepingExports, startingExports }) } catch (error) {
      findings.push({ file, line: 0, rule: 'unreadable', detail: `the check cannot read this file: ${error.message}` }); continue
    }
    if (!file.endsWith('.test.js')) { waitingExports.set(file, result.waiting); sleepingExports.set(file, result.sleeping); startingExports.set(file, result.starting) }
    for (const finding of result.findings) findings.push({ file, ...finding })
  }
  return findings.map(finding => ({ ...finding, file: relative(folder, finding.file) }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const findings = checkFolder(folder)
  for (const { file, line, rule, detail } of findings) console.error(`${basename(folder)}/${file}:${line}: ${rule}: ${detail}`)
  if (findings.length) {
    console.error(`${findings.length} wait(s) keep a bound of their own; wait through until() in test/support/wait.js, and on a child's exit or close through exited() or closed()`)
    process.exitCode = 1
  }
}
