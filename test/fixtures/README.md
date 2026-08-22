# Test fixtures

Locally captured copies of public Framer pages, used to pin the extractor's
behaviour against real Framer build output.

| File | Source | Tier |
|---|---|---|
| `framer-template.html` | framer-template.framer.website | free (badge present) |
| `linkin.html` | linkin.framer.website | free (badge present) |
| `novo.html` | novo.framer.website | free (badge present) |
| `framer-university.html` | framer.university | paid (no badge) |

These are development inputs only — third-party content, not ours to
redistribute. They are excluded from version control in `.gitignore`; the test
suite skips any fixture that is absent, so a fresh clone still runs green.

To refresh them:

```bash
curl -sL -A "Mozilla/5.0" https://framer-template.framer.website/ -o framer-template.html
```

The fixtures deliberately span both tiers and a range of page sizes (80 KB to
887 KB), because badge handling and animation-variant coverage differ between
them.
