# Security

## Keys

The public app runs in the browser. A Meta Model API key entered there stays
in the tab, or in the device's local storage only if the person asks, and is
sent only to `api.meta.ai`. It is never written to an exported tree, a
recording or the repository. Muse's drawings run in a sandboxed frame with no
network, storage or key.

## Reporting a vulnerability

Please report it privately, not in a public issue: through GitHub's private
vulnerability reporting on this repository where it is enabled, or by
contacting the maintainer through their GitHub profile. Include what you found, how to reproduce
it and what it exposes.
