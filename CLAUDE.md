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
