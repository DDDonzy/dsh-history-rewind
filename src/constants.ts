/**
 * Shared constants and plain data types for @deepseek-ai/dsh-history-rewind.
 */

/** HTTP route prefix served by the Host half for the browser channel. */
export const ROUTE_PREFIX = '/dsh-history-rewind/api'

/** Root directory (under $DSH_HOME) holding every shadow-store artifact. */
export const HISTORY_ROOT_DIRNAME = '.dsh-history-rewind'

/** Directory holding per-session bare repos (`repos/session-<id>.git`). */
export const REPOS_DIRNAME = 'repos'

/** Directory holding per-project workspace bare repos (`repos-ws/<project>.git`). */
export const REPOS_WS_DIRNAME = 'repos-ws'

/** Directory holding pre-rewind backups (session files + workspace trees). */
export const BACKUPS_DIRNAME = 'backups'

/** Directory holding per-project exclusive locks. */
export const LOCKS_DIRNAME = 'locks'

/** Branch name carrying the never-jumped original road of every session repo. */
export const MAIN_BRANCH = 'main'

/** Prefix of road branches (post-jump forks produced by content changes). */
export const ROAD_REF_PREFIX = 'refs/heads/road-'

/** Legacy old-model fork ref prefix (kept for purge compatibility only). */
export const LEGACY_ABANDONED_PREFIX = 'refs/heads/abandoned-'

/** Tree path prefix of the session artifact inside session-repo commits. */
export const SESSION_TREE_DIR = 'session-'

/** Basename of the official session artifact file inside tree + official layout. */
export const SESSION_FILE_BASENAME = 'session.jsonl.zstd'

/** Default workspace exclusion basenames written into every fresh ws repo. */
export const WORKSPACE_DEFAULT_EXCLUDES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vs',
]

/** Fixed identity stamped on shadow commits (never the user's git identity). */
export const COMMIT_AUTHOR_NAME = 'dsh-history'
/** Fixed author email for shadow commits. */
export const COMMIT_AUTHOR_EMAIL = 'history@dsh.local'

/** Age after which an abandoned lockfile is considered stale and stealable. */
export const LOCK_STALE_MS = 60_000

/** Commit-message marker prefix (the contract prose begins right after it). */
export const MESSAGE_PREFIX = 'dsh-history:'

/** git log format used by the timeline data source. */
export const LOG_FORMAT = '%H|%P|%s|%ct'
