# Working on Satchel with an AI coding agent

Three skills live in `.claude/skills/`. Read them in this order before making changes:

1. [contributing](.claude/skills/contributing/SKILL.md): layout, how a change travels, checks, docs and commit rules.
2. [design](.claude/skills/design/SKILL.md): the notebook-with-hardware direction, tokens, copy voice, accessibility.
3. [security](.claude/skills/security/SKILL.md): RLS, grants, the MCP server, the plugin, secrets, and the test checklist.

Claude Code loads them as project skills. Codex and other agents: read the three files above directly.

Hard rules: no AI co-author or "generated with" lines in commits or PR text. No service role key anywhere. No secrets in the repo or in chat. `npm test` and `npm run build` pass before a push.
