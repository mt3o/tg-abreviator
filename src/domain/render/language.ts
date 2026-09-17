/**
 * The bot's own strings — header, footer, errors — follow `bot.language`
 * (DESIGN §10, `botSection.language`). Rendering takes it as a plain value
 * rather than reading `Config` itself, keeping this module free of the
 * config-layers dependency (DESIGN §3).
 */
export type RenderLanguage = 'pl' | 'en';
