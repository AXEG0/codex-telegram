import net from 'node:net'
export function requestControl(path, action, args = {}, { signal, timeoutMs = 10_000, connectWaitMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let socket, retryTimer, buffer = '', settled = false
    const connectDeadline = Date.now() + Math.min(connectWaitMs, timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(retryTimer); signal?.removeEventListener('abort', abort); socket?.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error('control request cancelled'))
    const timer = setTimeout(() => finish(new Error('bridge control request timed out')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    const connect = () => {
      if (settled) return
      const current = socket = net.createConnection(path)
      let connected = false
      current.setEncoding('utf8')
      current.on('connect', () => { connected = true; current.write(`${JSON.stringify({ action, args })}\n`) })
      current.on('error', error => {
        if (!connected && ['ENOENT', 'ECONNREFUSED'].includes(error.code) && Date.now() < connectDeadline) {
          current.destroy(); retryTimer = setTimeout(connect, 50)
        } else finish(error)
      })
      current.on('end', () => { if (!settled) finish(new Error('bridge closed before returning a response')) })
      current.on('data', text => {
      buffer += text
      if (buffer.length > 1024 * 1024) return finish(new Error('bridge response exceeds 1 MiB'))
      const end = buffer.indexOf('\n'); if (end < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, end))
        // The bridge's own refusal is marked, so a caller can tell it from a connection that failed.
        finish(response.ok ? null : Object.assign(new Error(response.error || 'bridge rejected the request'), { refused: true }), response.result)
      } catch (error) { finish(error) }
      })
    }
    if (signal?.aborted) abort(); else connect()
  })
}
