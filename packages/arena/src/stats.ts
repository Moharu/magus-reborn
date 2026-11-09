/** z for a two-sided 95% interval. */
const Z95 = 1.959964

const round4 = (x: number) => Math.round(x * 10000) / 10000

/**
 * The 95% Wilson score interval for `wins` out of `games`, rounded to 4 decimals. Unlike the plain normal interval it
 * stays inside [0, 1] and is wide for small samples, so a rate from a few games is obviously uncertain. [0, 1] for
 * no games.
 */
export const wilsonInterval = (wins: number, games: number): { low: number; high: number } => {
    if (games <= 0) return { low: 0, high: 1 }
    const p = wins / games
    const z2 = Z95 * Z95
    const denominator = 1 + z2 / games
    const centre = (p + z2 / (2 * games)) / denominator
    const half = (Z95 * Math.sqrt((p * (1 - p)) / games + z2 / (4 * games * games))) / denominator
    return { low: round4(Math.max(0, centre - half)), high: round4(Math.min(1, centre + half)) }
}
