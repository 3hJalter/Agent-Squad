# Agent-Squad

Khung điều phối nhiều agent (lead + workers) để tiết kiệm token.

- `AGENTS.md`: quy tắc chung cho mọi agent. `CLAUDE.md`: luật bổ sung cho lead.
- `.agents/tasks/`: file task (không commit). Mẫu: `.agents/tasks/_template.md`.
- `scripts/start-agents.sh`: dựng phiên tmux (lead = claude, workers = codex/gemini, mỗi worker một git worktree).
- `scripts/assign.sh <ID> <worker>`: lead giao task. `scripts/notify.sh <ID>`: worker báo xong.

Chạy (trong WSL2/Linux, đã cài tmux, claude, codex):

    scripts/start-agents.sh        # hoặc WORKERS="codex gemini" scripts/start-agents.sh
    tmux attach -t agents
