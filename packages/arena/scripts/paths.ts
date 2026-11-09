import { resolve } from 'node:path'

/**
 * A file argument as the user meant it. `npm run arena` runs the script from `packages/arena/` (npm workspaces), so a
 * relative `--out` would land there instead of where the command was typed. npm sets `INIT_CWD` to that directory;
 * relative paths are resolved against it. `-` (stdout) is kept as it is.
 */
export const fromInvocation = (file: string) =>
    file === '-' ? file : resolve(process.env.INIT_CWD ?? process.cwd(), file)
