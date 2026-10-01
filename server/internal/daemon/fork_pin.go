package daemon

import "os"

// allowUpstreamUpdateEnv opts a daemon back in to replacing its own binary with
// an upstream release.
const allowUpstreamUpdateEnv = "MULTICA_DAEMON_ALLOW_UPSTREAM_UPDATE"

// forkBuildPinned reports whether this daemon must keep running the binary it
// was built from. Meetings, Workspace Knowledge, RTK prompts and the
// self-correction retry exist only in the fork build, so the server-triggered
// runtime update (and the GitHub auto-update) — both of which download the
// upstream release — are refused unless the operator opts in.
func forkBuildPinned() bool {
	return os.Getenv(allowUpstreamUpdateEnv) != "true"
}

const forkPinnedUpdateError = "CLI updates are disabled on this fork build (it carries fork-only features); rebuild the daemon from source, or set " + allowUpstreamUpdateEnv + "=true to allow replacing it with an upstream release"
