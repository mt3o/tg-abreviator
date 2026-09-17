/** DESIGN §6.8: permanent footer, in the chat's language. */
import { describe, expect, it } from 'vitest';

import { buildFooter } from './footer.js';

describe('buildFooter', () => {
  it('renders the English disclaimer', () => {
    expect(buildFooter('en')).toBe('🤖 AI summary — may be wrong');
  });

  it('renders the Polish disclaimer', () => {
    expect(buildFooter('pl')).toBe('🤖 Podsumowanie AI — może się mylić');
  });
});
