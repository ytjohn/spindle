# Main Session

The `main_session` feature pins spindle to a single designated session file,
preventing newer sessions from stealing focus.

## Configuration

```yaml
pi:
  main_session: true
```

## How It Works

1. On boot, spindle checks for a `.main-session` marker file in the session directory
2. If found, opens that specific session file (same as `resume_session` but automatic)
3. If not found:
   - Adopts the most recent existing session (migration from `continue_session`)
   - Or creates a new session if none exist
   - Writes the marker file

## Marker File

- **Location:** `<session_dir>/.main-session`
- **Content:** Absolute path to the pinned `.jsonl` file
- **Updated by:** Initial adoption, rotation (future)

## Migration from `continue_session`

Replace:
```yaml
pi:
  continue_session: true
```

With:
```yaml
pi:
  main_session: true
```

On next boot, spindle will find the most recent session (same one `continue_session`
would pick), adopt it as the main session, and write the marker. Future boots
always use the marker — immune to new sessions created by manual `pi` runs.

## Precedence

CLI `--resume <path>` > CLI `--new` > `main_session` > `resume_session` > `continue_session` > fresh

## Future: Session Rotation

A `/rotate-session` command will:
1. Find the last compaction entry in the current main session
2. Create a new session file containing only post-compaction history
3. Update the `.main-session` marker to point to the new file
4. Archive the old file (rename with `.archived` suffix or move to subdirectory)

This keeps the main session file from growing unbounded while preserving
the "pinned session" guarantee.
