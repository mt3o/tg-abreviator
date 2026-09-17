/**
 * DESIGN §6.8: "Permanent footer: `🤖 AI summary — may be wrong`, in the
 * chat's language."
 */
import type { RenderLanguage } from './language.js';

const FOOTER: Readonly<Record<RenderLanguage, string>> = {
  pl: '🤖 Podsumowanie AI — może się mylić',
  en: '🤖 AI summary — may be wrong',
};

export function buildFooter(language: RenderLanguage): string {
  return FOOTER[language];
}
