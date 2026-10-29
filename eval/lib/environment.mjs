// Evals call the same models production does and spend the same money, so
// their calls are traced too, under their own Langfuse environment. A cost
// question about evals is then one filter, and never mixed into a person's.
//
// Its own module so it runs before server/tracing.mjs reads the environment.
import {envValue} from '../../.claude/skills/daily-improvement/scripts/env.mjs';

process.env.LANGFUSE_TRACING_ENVIRONMENT ??= 'eval';
// Loaded into this process only, the way the review scripts read a key.
for (const name of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'])
  process.env[name] ??= envValue(name);
