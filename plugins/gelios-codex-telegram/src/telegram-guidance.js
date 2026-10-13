import { readFileSync } from 'node:fs'

export const telegramInstructions = readFileSync(new URL('./telegram-instructions.md', import.meta.url), 'utf8').trim()
export const telegramDeliveryInstructions = telegramInstructions.split(/\n\s*\n/)[1]?.replace(/\s*\n\s*/g, ' ')
if (!telegramInstructions || !telegramDeliveryInstructions) throw new Error('Telegram MCP instruction guide is empty or missing its delivery contract')
