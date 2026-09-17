# tg-abreviator

Telegram bot for making a summary when people talk a lot but you don't have time
to read all of this.

Reply to a message and call the bot to get a summary from that point on. Ask a
question instead and it answers from the chat history. Give it a timeframe
(`2h`, `wczoraj`, `last week`) or a message count (`-50`) and it uses that range.

## Status

Design complete, implementation not started.

- [`docs/DESIGN.md`](docs/DESIGN.md) — what is being built and why, including the
  Telegram API constraints that shape the whole thing, the privacy/retention
  model, and the safety rules.
- [`docs/PLAN.md`](docs/PLAN.md) — how it gets built: contracts first, then
  eleven workstreams with disjoint file ownership, designed to be implemented in
  parallel.

## The one thing to know before running this

The Telegram Bot API **cannot read chat history**. The bot can only summarize
messages it witnessed and stored itself, which means:

- privacy mode must be **off** in BotFather **and the bot re-added to the group**,
  otherwise it receives nothing and there is no corpus;
- nothing before installation can ever be summarized;
- messages are kept for a configurable TTL and then deleted.

See [`docs/DESIGN.md`](docs/DESIGN.md) §1 and §5.
