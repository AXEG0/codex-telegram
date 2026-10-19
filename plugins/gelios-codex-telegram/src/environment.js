// The launcher owns its environment; only the bridge's credentials are private.
export function runtimeEnvironment(source, { transcriptionKeyEnv, marketplaceAuthEnv } = {}, token = source.TELEGRAM_BOT_TOKEN) {
  const names = ['TELEGRAM_BOT_TOKEN', transcriptionKeyEnv,
    ...(marketplaceAuthEnv ? [marketplaceAuthEnv] : ['GH_TOKEN', 'GITHUB_TOKEN'])].filter(Boolean)
  const secrets = [...new Set([token, ...names.map(name => source[name])].filter(Boolean))].sort((a, b) => b.length - a.length)
  if (secrets.some(value => /[\u0000-\u001f\u007f]/.test(value))) throw new Error('credential values cannot contain control characters')
  const env = Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    !names.includes(name) && !secrets.some(secret => name.includes(secret) || String(value).includes(secret))))
  return { env, secrets }
}
