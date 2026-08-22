# Security

## Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's Security tab, rather than opening a public issue.

## If you self-host the server

`unframer serve` accepts a URL from whoever can reach it and fetches that URL from your machine. Two things follow.

**It is a fetching service.** Exposing it publicly means strangers can make your server issue outbound HTTP requests. `src/ssrf.ts` resolves each hostname and rejects private, loopback, link-local and reserved ranges — including cloud metadata endpoints like `169.254.169.254` — but that guard protects your internal network, not your bandwidth or your IP's reputation. Put it behind authentication or a rate limit before putting it on the internet.

**Exports are written to disk and served back.** Job artifacts land in a temp directory and are served only from the path the job itself produced; client input never selects a file. They are not cleaned up on a schedule, so a long-running public instance will accumulate them.

## What the tool does with fetched pages

Exported HTML is parsed and rewritten, never executed. The extractor removes the page's scripts rather than running them, so a hostile page cannot execute code in the exporter.

The generated shim (`src/shim.ts`) is our own code, contains no page-derived content, and is the only JavaScript added to output. Everything else the exporter emits is CSS and markup derived from the page's existing structure.

## Known limitations

- Content from an exported page ends up in the output verbatim; if you export a site with untrusted user-generated content, that content is still there afterwards.
- The SSRF guard resolves DNS once at validation time. A hostname that resolves differently between validation and fetch (DNS rebinding) is not currently defended against; it would require pinning the resolved address through to the request.
