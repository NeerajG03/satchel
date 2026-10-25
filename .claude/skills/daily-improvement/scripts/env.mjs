// Where the review's scripts find a secret: the app's own `.env` in the main
// checkout first, then ~/.config/env. The app's file is the only one the person
// has to share with the review, so a key goes there and nowhere else.
import {existsSync, readFileSync} from 'node:fs';

export function envFiles() {
  return [`${process.env.SATCHEL_REPO ?? '/Volumes/Casesensitive/Github/satchel'}/.env`, `${process.env.HOME}/.config/env`];
}

/** The value of one variable, or undefined. Never prints, never sources the file. */
export function envValue(name) {
  for (const file of envFiles()) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const clean = line.replace(/^export\s+/, '').trim();
      if (clean.startsWith(`${name}=`)) return clean.slice(name.length + 1).replace(/^['"]|['"]$/g, '');
    }
  }
  return undefined;
}
