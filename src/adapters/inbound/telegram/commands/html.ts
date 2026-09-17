/**
 * Minimal HTML escaping for the plain-text command replies (DESIGN §6.5:
 * "everything else escaped").
 *
 * Command replies never use `<b>`/`<i>`/`<code>` markup themselves — they are
 * plain sentences — so there is no allowlist to preserve, only user- or
 * operator-supplied fragments (a mistyped range token, an IANA zone, a config
 * value) that must not be interpreted as Telegram HTML once
 * `ChatGateway.sendText` renders them.
 */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
