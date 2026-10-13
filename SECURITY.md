# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/mbaxszy7/Pact/security/advisories/new).
Include revision, platform/CLI versions, reproduction, expected/actual behavior, and a minimal redacted
example. Do not post credentials, private project content, databases, authentication headers, or raw
agent traces in public issues. There is no stable release support window; fixes target maintained main.

## Trust boundaries

Renderer is sandboxed and browser-only. Privileged operations cross validated DesktopBridge/Main/
Utility boundaries; only registered Pact main frames may invoke them. Utility owns native CLIs and
persistence. Project content, links, native output, MCP replies, and generated text remain untrusted.
OS/CLI sandbox and permission capabilities vary; refuse unverified authority rather than inventing
successful permission transitions.

Records are local, but authorized Agent requests can send content to configured providers. Local
storage does not imply offline execution. Hooks, tools, integrations, and external operations retain
their own side effects. Report findings with their exact observed scope.

## Keep secrets and personal data out of Git

Provider homes, E2E configuration, environment files, keys, databases, checkpoints, traces, and logs
are private. Ignore rules are only a convenience. Publication policy rejects forbidden paths, and
Gitleaks 8.30.1 scans staged changes and CI history with redacted output. Missing tools, errors, and
deadlines fail closed. Inline allow comments/local ignore files are not honored; synthetic credentials
must be visibly nonfunctional with narrowly scoped exceptions.

Repository push protection provides an additional server-side check for supported credential patterns.
Hooks can be bypassed and CI runs after upload: neither guarantees detection of every secret format.
Review every release/export. Keep signing credentials in controlled release environments, never in
the repository or external-PR jobs.

## If a credential is exposed

Revoke or rotate it immediately. Remove it from current files, inspect history/published artifacts,
and coordinate history cleanup with maintainers. Deleting a file or making a repository private does
not revoke copied credentials. Never repeat credentials in reports, screenshots, commits, or cleanup
logs. Resolve findings before publication rather than adding broad scan exclusions.

## Test isolation

Use fixture-owned projects, provider homes, databases, and process identities. Reproductions against
daily sessions require explicit authorization. Unknown delivery does not permit model retries; process
cleanup is not provider completion evidence. See [testing](docs/testing.md) and
[architecture](docs/technical-foundation.md).
