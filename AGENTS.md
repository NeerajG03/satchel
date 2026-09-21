# Working on Satchel with an AI coding agent

Eight skills live in `.claude/skills/`. Read these three in this order before making changes:

1. [contributing](.claude/skills/contributing/SKILL.md): layout, how a change travels, checks, docs and commit rules.
2. [design](.claude/skills/design/SKILL.md): the notebook-with-hardware direction, tokens, copy voice, accessibility.
3. [security](.claude/skills/security/SKILL.md): RLS, grants, the MCP server, the plugin, secrets, and the test checklist.

Then read the one that covers the subsystem you are touching:

4. [satchel-memory](.claude/skills/satchel-memory/SKILL.md): capture, retrieval, embeddings, the eval.
5. [satchel-tasks](.claude/skills/satchel-tasks/SKILL.md): task states, updates, planning edges, resources, storage.
6. [satchel-projects](.claude/skills/satchel-projects/SKILL.md): projects as the scope that memories, tasks and grants hang off.
7. [satchel-apps](.claude/skills/satchel-apps/SKILL.md): OAuth, grants, the MCP handler, the plugin packages and hooks.

And when something is not working and you need evidence rather than a reading of the code:

8. [debugging](.claude/skills/debugging/SKILL.md): reading Langfuse traces and querying the live database, how to reach both, and which questions each one can answer.

Claude Code loads them as project skills. Codex and other agents: read the files above directly.

Hard rules: no AI co-author or "generated with" lines in commits or PR text. No service role key anywhere. No secrets in the repo or in chat. `npm test` and `npm run build` pass before a push.
