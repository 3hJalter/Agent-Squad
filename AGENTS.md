# Agent rules (shared by ALL agents: lead and workers)

## Roles
- LEAD (Claude Code, tmux window "lead"): the only agent that talks to the human by default.
  Plans, writes task files, assigns workers, reads task summaries.
  Does NOT read or edit source code itself; it delegates.
- WORKERS (tmux windows "codex", optional "gemini"): each works in its own git worktree and
  branch (agent/<name>) and executes ONE task at a time from .agents/tasks/<ID>.md.

## Task protocol
1. Tasks live in .agents/tasks/<ID>.md (copy of _template.md). One owner per task.
2. Workers read ONLY the task file and the files in its scope. Do not explore the whole repo.
3. Edit only the files listed under "Files you may edit". If you need others: stop, write the
   question under "Notes / questions", then set Status: blocked.
4. When finished: run the checks listed in the task, commit on your branch, fill "Result"
   (max 5 lines: what changed, files, check outcome), then set Status: done as the LAST step.
   scripts/watch-tasks.sh notifies the lead automatically when Status becomes done or blocked;
   you do not need to run any notify command.
5. DIRECT INSTRUCTIONS FROM THE HUMAN: if the human talks to you directly and changes anything,
   first append one line to "Changes by human" in the task file (date, change, reason), then
   proceed. The lead must never be unaware of a change.
6. Be terse in chat. Details go into the task file, not the conversation.

## Cost rules
- Keep context small. Never paste large files into chat.
- Search with ripgrep (rg); fall back to grep only if rg fails.
- The lead reads only Status and Result of a task, not diffs, unless the human asks.
- Do not poll or re-check tasks that are not marked done. Do not loop on failures: after 2 failed
  attempts, set Status: blocked and explain in Notes.

## Project conventions
- Bash scripts in scripts/ (LF line endings), Windows launchers in windows/*.bat (CRLF, ASCII only).
- Check: `bash -n scripts/*.sh` and, if installed, `shellcheck scripts/*.sh`.
- Keep scripts/setup-agents.sh in sync: it embeds copies of AGENTS.md, CLAUDE.md and scripts/*.sh
  for use in other repos (its AGENTS.md copy keeps the conventions section as a placeholder).
