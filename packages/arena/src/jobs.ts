/** The most worker processes a run may use. Higher values are clamped, so a typo cannot overload a machine. */
export const MAX_JOBS = 4
/** Worker processes when `--jobs` is not given. */
export const DEFAULT_JOBS = 4

/**
 * The number of worker processes for a requested `--jobs` value: `DEFAULT_JOBS` when absent, clamped to `MAX_JOBS` with
 * a warning to show the user. Throws when the value is not a positive integer.
 */
export const clampJobs = (requested?: number): { jobs: number; warning?: string } => {
    if (requested === undefined) return { jobs: DEFAULT_JOBS }
    if (!(Number.isInteger(requested) && requested >= 1)) throw new Error(`--jobs must be at least 1, got ${requested}`)
    if (requested > MAX_JOBS)
        return { jobs: MAX_JOBS, warning: `--jobs ${requested} is above the maximum of ${MAX_JOBS}: using ${MAX_JOBS}` }
    return { jobs: requested }
}
