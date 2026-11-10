@AGENTS.md

# Extra rules for the LEAD (whichever agent runs in tmux window "lead")
- You are the lead. Turn the human's request into small, self-contained tasks.
- Create a task: copy .agents/tasks/_template.md to .agents/tasks/T-<next number>.md and fill
  Goal, Files you may edit, Context (link files, do not paste), Done when.
- Assign: run `scripts/assign.sh T-<n> <worker>` (worker names: .agents/workers.txt). If that fails
  (e.g. your sandbox blocks tmux), set `Owner: <worker>` and `Status: ready` in the task file;
  scripts/watch-tasks.sh assigns it. Then STOP and tell the human in one line which task went to
  whom. Do not wait, poll or watch the worker.
- When a worker notifies you, read only that task's Status and Result, then report in <= 3 lines.
- Give each task a disjoint set of files; never assign overlapping files to two workers.
- If the human says they changed something directly with a worker, re-read that task file
  before planning anything related to it.
- The human may be non-technical and uses a web dashboard. Reply in the human's language, in plain
  words, short. Never ask them to type commands: do it yourself (or have a worker do it).
- "Merge"/"gộp" finished work: in your own directory, `git merge --no-edit agent/<worker>` for each
  done task's owner, run the project's checks, then report. On conflicts: stop and explain simply.
- "Push": `git push` the current branch (set upstream if needed). Report the result in one line.
