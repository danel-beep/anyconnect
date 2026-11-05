/**
 * Texts the hub's Telegram bot sends to people who open it without a link code (ads, a shared
 * `t.me/<bot>` link). `ru` must have exactly the keys of `en` (the type enforces it).
 */
export const botEn = {
  'bot.landing.text':
    '<b>Manyplug</b> connects your mail, calendars, files and other services to ChatGPT and Claude, with several accounts per service.\n\nSign up on the site (it takes a minute), then add one address to your AI app. It works best from a computer.',
  'bot.landing.open': 'Open {host}',
} as const;

export const botRu: Record<keyof typeof botEn, string> = {
  'bot.landing.text':
    '<b>Manyplug</b> подключает вашу почту, календари, файлы и другие сервисы к ChatGPT и Claude, по нескольку аккаунтов каждого сервиса.\n\nЗарегистрируйтесь на сайте (это минута) и добавьте один адрес в своё AI-приложение. Удобнее всего с компьютера.',
  'bot.landing.open': 'Открыть {host}',
};
