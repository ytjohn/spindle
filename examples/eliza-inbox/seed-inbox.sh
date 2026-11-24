#!/usr/bin/env bash
# Seed Eliza's inbox with a few fixture messages so "check your inbox"
# actually has something to find. Idempotent — rewrites the files each
# run. Run FROM the agent dir: `cd examples/eliza-inbox && ./seed-inbox.sh`.
#
# Generates fixtures under ./mail/inbox/. Spindle's projector picks them
# up within `poll_interval_seconds` of the next boot (or immediately via
# backfill at the next boot).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INBOX="${HERE}/mail/inbox"
mkdir -p "${INBOX}"

# ---- fixture 1: friendly note from a recurring persona -------------
cat > "${INBOX}/2026-04-17-jessica-pixel.md" <<'EOF'
---
id: 2026-04-17-jessica-pixel
from_auth: operator:example
from: Jessica
to: eliza-inbox
subject: Pixel update
date: 2026-04-17T09:14:00-04:00
priority: normal
---

Hi Eliza!

Pixel is doing great — she's finally warming up to the new couch. Thought
you'd want to know since you were the one who predicted she'd come around.

— Jess
EOF

# ---- fixture 2: urgent priority message from a pseudonym ----------
cat > "${INBOX}/2026-04-17-acme-firmware.md" <<'EOF'
---
id: 2026-04-17-acme-firmware
from_auth: operator:example
from: Acme Orders
to: eliza-inbox
subject: Firmware update — end of week
date: 2026-04-17T11:02:00-04:00
priority: high
---

Eliza,

We need the firmware update pushed by end of week. The hardware team is
blocked on the new API. See the thread in Slack for the full changelog.

— Acme Ops
EOF

# ---- fixture 3: low-priority community digest ---------------------
cat > "${INBOX}/2026-04-16-community-digest.md" <<'EOF'
---
id: 2026-04-16-community-digest
from_auth: operator:example
from: Community Digest
to: eliza-inbox
subject: Weekly highlights
date: 2026-04-16T08:00:00-04:00
priority: low
kind: notice
---

This week: 3 new tutorials, 2 release notes, and a reminder that the
office hours are moving to Thursdays. Full list on the wiki.
EOF

echo "Seeded ${INBOX}:"
ls -1 "${INBOX}"
