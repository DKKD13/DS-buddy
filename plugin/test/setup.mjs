// Temporary folders must be canonical paths: the file store refuses a root that resolves somewhere else,
// and the default temporary folder on macOS sits behind a symlink (/var -> /private/var).
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

process.env.TMPDIR = realpathSync(tmpdir())
