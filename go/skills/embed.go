package skills

import "embed"

// Files are embedded so the single executable includes all built-in skills.
//
//go:embed */SKILL.md
var Files embed.FS
