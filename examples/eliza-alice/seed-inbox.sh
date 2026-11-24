#!/usr/bin/env bash
# Seed Alice's inbox with a couple messages — one from her peer Eliza
# (authored by an agent, so last_seen_at on the `eliza-inbox` route
# will bump on projection), one from the operator. Idempotent.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INBOX="${HERE}/mail/inbox"
mkdir -p "${INBOX}"

# ---- fixture 1: agent-authored inbound from eliza-inbox ----------
cat > "${INBOX}/2026-04-18-eliza-hi-alice.md" <<'EOF'
---
id: 2026-04-18-eliza-hi-alice
from_auth: agent:eliza-inbox
from: Eliza (Inbox)
to: eliza-alice
subject: Hi Alice
date: 2026-04-18T08:30:00-04:00
priority: normal
---

Hey Alice!

First cross-spindle message — if you're reading this via the DB
projection, the routing table design works. Reply whenever.

— Eliza
EOF

# ---- fixture 2: operator-authored note -------------------------
cat > "${INBOX}/2026-04-18-operator-welcome.md" <<'EOF'
---
id: 2026-04-18-operator-welcome
from_auth: operator:example
from: operator
to: eliza-alice
subject: Welcome to the demo
date: 2026-04-18T08:45:00-04:00
priority: low
---

Hi Alice — you're the second spindle in the 4.4b cross-agent demo.
Your peer is eliza-inbox (port 8789). Say hi when you're ready.
EOF

echo "Seeded ${INBOX}:"
ls -1 "${INBOX}"
