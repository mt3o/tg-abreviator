/**
 * Intent (DESIGN §2, "Range × intent are orthogonal").
 *
 * The same range token means the same window whether the user asked a question
 * or not; the presence of free text after the leading token is the only thing
 * that decides between summarizing and answering.
 */

export type Intent =
  | { readonly kind: 'summarize' }
  | { readonly kind: 'answer'; readonly question: string };

export const SUMMARIZE: Intent = Object.freeze({ kind: 'summarize' });

export function answerIntent(question: string): Intent {
  return Object.freeze({ kind: 'answer', question });
}
