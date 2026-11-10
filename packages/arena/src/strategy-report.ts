import { ELEMENT_SPELL_COUNT } from '@magus/engine'
import { rate, rateWithInterval, table, type ReportOptions } from './report'
import { wilsonInterval } from './stats'
import { setLabel, type StrategyCell, type StrategyResult } from './strategy'
import { NO_GAMES, percent, spellName } from './tournament-format'

/**
 * The strategy tournament's report (#137), in the style of the arena report (#105): Markdown, a pure function of the
 * result and the two options, every rate with its 95% Wilson interval, draws counted as non-wins.
 */
export const STRATEGY_REPORT_SECTIONS = [
    'Header',
    'Setups',
    'Best profile per general pair',
    'Rank by setup',
    'Matchup matrices',
    'Caveats',
] as const

/** The two general spells of a setup as `Haste + Blur`. */
const pairNames = (pair: readonly string[]) => pair.map(spellName).join(' + ')

export const formatStrategyReport = (result: StrategyResult, options: ReportOptions): string => {
    const { config, partial } = result
    const profiles = config.profiles.map(p => p.name)
    const cellsPerSetup = (profiles.length * (profiles.length + 1)) / 2
    const perCell = config.seeds * config.games

    const header = [
        '## Header',
        '',
        `- **Version:** \`${config.baselineVersion}\``,
        `- **Seed:** ${config.seed}`,
        `- **Date:** ${options.date} (UTC)`,
        ...(options.commit === undefined ? [] : [`- **Commit:** \`${options.commit}\``]),
        `- **Status:** ${
            partial
                ? `PARTIAL: ${partial.jobsPlayed} of ${partial.jobsTotal} jobs played` +
                  (partial.missingShards ? `, missing shards ${partial.missingShards.join(', ')}` : '')
                : `complete: ${config.setups.length * cellsPerSetup * config.seeds} jobs played`
        }`,
        `- **Setups:** ${config.setups.length} (${config.fireSets.length} Fire set(s) x 6 general pairs), every one a mirror`,
        `- **Profiles:** ${profiles.length} (${profiles.join(', ')}), each playing every profile, itself included`,
        `- **Games:** ${perCell} per cell (${config.seeds} derived seeds x ${config.games} games), ${result.games} played, time cap ${config.maxTicks} ticks`,
    ].join('\n')

    const setups = [
        '## Setups',
        '',
        `Both players of a game get the same loadout, so the only thing that differs is the profile. A setup is a Fire set (F<n>, or a Frost set, I<n>, #150) with a pair of the four non-${spellName('SPELL_COUNTERSPELL')} general spells (Counterspell is always in the loadout). "Dummy baseline" is the best loadout of that set in its element's table (\`baselines/${config.baselineVersion}.json\`, or \`baselines/${config.baselineVersion}-frost.json\` for Frost) (DPS on a passive dummy, and under the search's Counterspell-pressure model).`,
        '',
        '### Fire sets',
        '',
        table(
            ['Fire set', 'Spells', 'Source', 'Dummy baseline'],
            config.fireSets.map((set, i) => [
                setLabel(set, i),
                set.spells.map(spellName).join(', '),
                set.source === 'baseline' ? 'best set of the dummy baseline' : '`--fire-set`',
                set.baseline
                    ? `rank ${set.baseline.rank}: ${set.baseline.dps.toFixed(1)} DPS, ${set.baseline.dpsUnderPressure.toFixed(1)} under pressure`
                    : 'not in the baseline',
            ]),
            [0, 1, 2, 3],
        ),
        '',
        '### General pairs',
        '',
        table(
            ['Setup', 'Fire set', 'Counterspell', 'General pair'],
            config.setups.map(s => [
                s.id,
                setLabel(config.fireSets[s.fireSet], s.fireSet),
                spellName(s.loadout[ELEMENT_SPELL_COUNT]),
                pairNames(s.pair),
            ]),
            [0, 1, 2, 3],
        ),
    ].join('\n')

    const best = [
        '## Best profile per general pair',
        '',
        `Win rate (95% Wilson interval) of each profile with each general pair, pooled over ${config.fireSets.length} Fire set(s) and over its games against the other profiles (mirror games are left out). "Best" is the highest win rate; "Clear" says whether its interval lies clear of the runner-up's, otherwise the two are not reliably different.`,
        '',
        table(
            ['General pair', 'Best', 'Clear', ...profiles],
            result.pairs.map(p => [
                pairNames(p.spells),
                p.ranking[0].games === 0 ? NO_GAMES : p.best,
                p.ranking[0].games === 0 ? '-' : p.separated ? 'yes' : `no (${p.ranking[1].profile} overlaps)`,
                ...profiles.map(name => {
                    const r = p.ranking.find(x => x.profile === name)
                    return r ? rateWithInterval(r.wins, r.games) : '-'
                }),
            ]),
            [0, 1, 2],
        ),
    ].join('\n')

    const rankBySetup = [
        '## Rank by setup',
        '',
        "Each profile's rank on each setup, by its win rate against the other profiles (mirror games are left out), with that win rate. Rank 1 is best; profiles with no games rank last.",
        '',
        table(
            ['Setup', ...profiles],
            result.rankings.map(({ setup, ranking }) => [
                setup,
                ...profiles.map(name => {
                    const r = ranking.find(x => x.profile === name)
                    return r ? `${r.rank} (${r.games === 0 ? NO_GAMES : percent(r.winRate)})` : '-'
                }),
            ]),
        ),
    ].join('\n')

    const cellFor = (setup: string, row: string, column: string): StrategyCell | undefined =>
        result.cells.find(
            c => c.setup === setup && ((c.a === row && c.b === column) || (c.a === column && c.b === row)),
        )
    const matrices = [
        '## Matchup matrices',
        '',
        'One matrix per setup: the share of games the row profile won against the column profile, with its 95% Wilson interval. Draws are non-wins, so a row and its mirrored column add to less than 100% by the draws. On the diagonal both players are the same profile, so the cell shows the share of games won by whoever moved first (`player1`, "1st"). A ranking follows each matrix.',
        ...result.rankings.flatMap(({ setup, ranking }) => {
            const info = config.setups.find(s => s.id === setup)
            return [
                '',
                `### ${setup}`,
                '',
                info ? `${info.loadout.map(spellName).join(', ')}` : '',
                '',
                table(
                    ['Row \\ column', ...profiles],
                    profiles.map(row => [
                        row,
                        ...profiles.map(column => {
                            const cell = cellFor(setup, row, column)
                            if (!cell || cell.games === 0) return NO_GAMES
                            if (row === column) return `1st ${rateWithInterval(cell.firstWins, cell.games)}`
                            return rateWithInterval(cell.a === row ? cell.winsA : cell.winsB, cell.games)
                        }),
                    ]),
                ),
                '',
                table(
                    ['#', 'Profile', 'Wins', 'Draws', 'Games', 'Win rate', '95% CI'],
                    ranking.map(r => [
                        String(r.rank),
                        r.profile,
                        String(r.wins),
                        String(r.draws),
                        String(r.games),
                        r.games === 0 ? NO_GAMES : percent(r.winRate),
                        r.games === 0 ? NO_GAMES : `${percent(r.ci95.low)}-${percent(r.ci95.high)}`,
                    ]),
                    [0, 1],
                ),
            ]
        }),
    ].join('\n')

    const played = result.cells.filter(c => c.games > 0)
    const draws = played.reduce((sum, c) => sum + c.draws, 0)
    const decided = result.games - draws
    const firstWins = played.reduce((sum, c) => sum + c.firstWins, 0)
    const widest = (c: StrategyCell) => {
        const counts = c.a === c.b ? [c.firstWins] : [c.winsA, c.winsB]
        return Math.max(...counts.map(w => (wilsonInterval(w, c.games).high - wilsonInterval(w, c.games).low) / 2))
    }
    const caveats = [
        '## Caveats',
        '',
        partial
            ? `- **Partial run.** ${
                  partial.missingShards
                      ? `Shards ${partial.missingShards.join(', ')} were missing (their job failed), so`
                      : 'The time budget ended the run, so'
              } only ${partial.jobsPlayed} of ${partial.jobsTotal} jobs were played. Cells that were not finished hold fewer games: compare the Games column before the win rates. A run stopped by its time budget is not reproducible, because where it stops depends on the machine's speed.`
            : '- **Partial runs.** This run is complete: every job was played.',
        `- **Draws.** ${draws} of ${result.games} games (${percent(rate(draws, result.games))}) were draws (time cap or both players dead on one tick). They score no win for either profile.`,
        `- **Sample size.** Each cell has ${perCell} games (${config.seeds} derived seeds x ${config.games}). The widest 95% interval of a cell is +/- ${percent(Math.max(0, ...played.map(widest)))}; profiles whose intervals overlap are not reliably different.`,
        `- **First mover.** \`player1\` acts first within a tick and won ${percent(rate(firstWins, decided))} of the ${decided} decided games; sides alternate, so each profile had it in half its games.`,
        '- **Mirrors.** A profile playing itself says nothing about which profile is better, so those games are in the diagonal cells only and not in any ranking.',
        '- **Meaning.** Win rates describe these profiles playing the same loadout against each other, not human play. They separate strategy from loadout strength, but each rank is of the profile as written (adapted to the loadout), not of a strategy in general.',
    ].join('\n')

    return [
        `# Arena strategy report: ${config.baselineVersion}`,
        '',
        header,
        '',
        setups,
        '',
        best,
        '',
        rankBySetup,
        '',
        matrices,
        '',
        caveats,
        '',
    ].join('\n')
}

/** The compact text the CLI prints: the rank of every profile on every setup, then the best profile per general pair. */
export const formatStrategyTable = (result: StrategyResult): string => {
    const { config } = result
    const profiles = config.profiles.map(p => p.name)
    const rows = result.rankings.map(({ setup, ranking }) => [
        setup,
        ...profiles.map(name => {
            const r = ranking.find(x => x.profile === name)
            return r ? `${r.rank} ${r.games === 0 ? NO_GAMES : percent(r.winRate)}` : '-'
        }),
    ])
    const header = ['setup', ...profiles]
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)))
    const line = (cells: string[]) =>
        cells
            .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
            .join('  ')
            .trimEnd()
    return [
        `${result.games} games, ${config.setups.length} mirror setups x ${profiles.length} profiles, ${config.seeds * config.games} games per cell, seed ${config.seed}, baseline ${config.baselineVersion}.`,
        ...(result.partial
            ? [
                  `PARTIAL: ${result.partial.jobsPlayed} of ${result.partial.jobsTotal} jobs played${result.partial.missingShards ? ` (missing shards ${result.partial.missingShards.join(', ')})` : ''}.`,
              ]
            : []),
        'Rank and win rate of each profile against the others, per setup:',
        line(header),
        ...rows.map(line),
        '',
        'Best profile per general pair:',
        ...result.pairs.map(
            p =>
                `${p.pair.padEnd(28)} ${p.ranking[0].games === 0 ? NO_GAMES : `${p.best} ${percent(p.ranking[0].winRate)}${p.separated ? '' : ' (not clear of ' + p.ranking[1].profile + ')'}`}`,
        ),
    ].join('\n')
}
