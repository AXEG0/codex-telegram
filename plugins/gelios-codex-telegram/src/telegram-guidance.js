import { readFileSync } from 'node:fs'

export const telegramInstructions = readFileSync(new URL('./telegram-instructions.md', import.meta.url), 'utf8').trim()
export const telegramDeliveryInstructions = telegramInstructions.split(/\n\s*\n/)[1]?.replace(/\s*\n\s*/g, ' ')
if (!telegramInstructions || !telegramDeliveryInstructions) throw new Error('Telegram MCP instruction guide is empty or missing its delivery contract')

export function withTelegramDelivery(input) {
  const first = input?.[0]
  const prefix = first?.type === 'text' && /^(\[Telegram\/[^\n]*\]\nTelegram metadata:[^\n]*\n)/.exec(first.text)?.[1]
  if (!prefix) return input
  const notice = `Telegram delivery: ${telegramDeliveryInstructions}\n`
  if (first.text.startsWith(prefix + notice)) return input
  return [{ ...first, text: prefix + notice + first.text.slice(prefix.length) }, ...input.slice(1)]
}
