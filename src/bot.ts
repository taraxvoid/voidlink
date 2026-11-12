// Link-preview crawlers (chat apps, social platforms, search engines) and
// HTTP libraries fetch shared URLs without a person behind them. Counting
// those as clicks inflates analytics with traffic nobody saw.
const BOT_UA = new RegExp(
    [
        'bot',
        'spider',
        'crawl',
        'slurp',
        'preview',
        'facebookexternalhit',
        'whatsapp',
        'telegram',
        'embedly',
        'iframely',
        'vkshare',
        'skypeuripreview',
        'pinterest',
        'viber',
        'headlesschrome',
        'curl/',
        'wget/',
        'httpie/',
        'python-requests',
        'go-http-client',
    ].join('|'),
    'i',
)

/** Missing User-Agents count as bots: real browsers always send one. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
    return !userAgent || BOT_UA.test(userAgent)
}
