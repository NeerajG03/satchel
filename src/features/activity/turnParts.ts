export type TurnAction = { verb: string; target: string };
export type TurnParts = { text: string; actions: TurnAction[] };

const HEADER = 'Actions this turn:';

/** Splits a kept turn into what was said and what the agent did.
 *
 *  The actions are only the last "Actions this turn:" block, and only when
 *  nothing but "- " lines follow it, so a reply that talks about the phrase
 *  is left whole. */
export function turnParts(content: string): TurnParts {
  const at = content.lastIndexOf(HEADER);
  const whole = { text: content, actions: [] };
  if (at === -1 || (at > 0 && content[at - 1] !== '\n')) return whole;
  const lines = content.slice(at + HEADER.length).split('\n').map(line => line.trimEnd());
  if (lines[0] !== '') return whole;
  const rest = lines.slice(1).filter(line => line !== '');
  if (!rest.length || !rest.every(line => line.startsWith('- '))) return whole;
  return {
    text: content.slice(0, at).trim(),
    actions: rest.map(line => {
      const body = line.slice(2);
      const colon = body.indexOf(': ');
      return colon === -1 ? { verb: '', target: body } : { verb: body.slice(0, colon), target: body.slice(colon + 2) };
    }),
  };
}

const VERB_LABEL: Record<string, string> = {
  ran: 'Ran', edited: 'Edited', read: 'Read', searched: 'Searched', used: 'Used',
};

/** The word a person sees for a verb. One we have not met is shown as it came. */
export function verbLabel(verb: string): string {
  return VERB_LABEL[verb] ?? (verb ? verb[0].toUpperCase() + verb.slice(1) : 'Did');
}
