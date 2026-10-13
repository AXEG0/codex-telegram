import net from 'node:net'
export function requestControl(path, action, args = {}, { signal, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    let buffer = '', settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error('control request cancelled'))
    const timer = setTimeout(() => finish(new Error('bridge control request timed out')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ action, args })}\n`))
    socket.on('error', error => finish(error))
    socket.on('end', () => { if (!settled) finish(new Error('bridge closed before returning a response')) })
    socket.on('data', text => {
      buffer += text
      if (buffer.length > 1024 * 1024) return finish(new Error('bridge response exceeds 1 MiB'))
      const end = buffer.indexOf('\n'); if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end))
        finish(response.ok ? null : new Error(response.error || 'bridge rejected the request'), response.result)
      } catch (error) { finish(error) }
    })
  })
}
