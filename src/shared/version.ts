/**
 * The `version` every data file is written with. Kept in its own zod-free module so the renderer
 * (which must not bundle zod) stamps files with the same constant main validates against.
 * Bump it only together with a migration step in src/main/storage/migrations.ts.
 */
export const SCHEMA_VERSION = 1 as const

export type SchemaVersion = typeof SCHEMA_VERSION
