export type Host = 'claude' | 'codex';

export const CATALOG = 'NeerajG03/satchel-plugins';

export const HOST_NAMES: Record<Host, string> = { claude: 'Claude Code', codex: 'Codex' };

export const INSTALL: Record<Host, string[]> = {
  claude: [`claude plugin marketplace add ${CATALOG}`, 'claude plugin install satchel@satchel'],
  codex: [`codex plugin marketplace add ${CATALOG}`, 'codex plugin add satchel@satchel'],
};

export const LOGIN: Record<Host, string> = {
  claude: 'claude mcp login plugin:satchel:satchel',
  codex: 'codex mcp login satchel',
};

export const PROMPT: Record<Host, string> = {
  claude: `Install the Satchel plugin for me. Run these two commands in order and show me what each printed:
${INSTALL.claude.join('\n')}
When both succeed, tell me to run this myself in a terminal, because it opens a browser sign-in you cannot complete:
${LOGIN.claude}
Then tell me to restart Claude Code so the Satchel hooks load my memory index.`,
  codex: `Install the Satchel plugin for me. Run these two commands in order and show me what each printed:
${INSTALL.codex.join('\n')}
When both succeed, tell me to run this myself in a terminal, because it opens a browser sign-in you cannot complete:
${LOGIN.codex}
Then tell me to review the Satchel hooks with /hooks and start a fresh task so my memory index loads.`,
};
