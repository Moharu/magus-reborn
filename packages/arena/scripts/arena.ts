// `npm run arena -- [--mode tournament|strategy] ...`: the entry point of the two arena modes (default: tournament).
//   tournament  the round-robin of loadouts x profiles (scripts/tournament.ts, also `npm run arena:tournament`)
//   strategy    the strategy tournament (#137), mirror setups where only the profile varies (scripts/strategy.ts, also
//               `npm run arena:strategy`)
// `--mode` is taken out of the command line, then the mode's script runs with the rest. The script's own worker
// processes run that script directly, so they never see `--mode`.
export {}

const MODES = ['tournament', 'strategy'] as const

const i = process.argv.indexOf('--mode')
let mode: (typeof MODES)[number] = 'tournament'
if (i !== -1) {
    const value = process.argv[i + 1]
    if (value === undefined || !(MODES as readonly string[]).includes(value)) {
        console.error(`--mode must be one of ${MODES.join(', ')}, got ${value ?? 'nothing'}`)
        process.exit(1)
    }
    mode = value as (typeof MODES)[number]
    process.argv.splice(i, 2)
}
if (process.argv.slice(2).includes('--mode')) {
    console.error('--mode is given twice')
    process.exit(1)
}

await import(mode === 'strategy' ? './strategy' : './tournament')
