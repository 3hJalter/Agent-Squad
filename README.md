# Agent-Squad

Khung điều phối nhiều agent (lead + workers) để tiết kiệm token.

**Trên Windows (sau khi đã chạy xong 1→3 trong `windows/`): double-click `Agent-Squad.bat`.**
File này cập nhật code trong WSL, bật các agent và mở dashboard thành cửa sổ riêng.
Để nguyên cửa sổ thu nhỏ "Agent-Squad server" trên taskbar; đóng nó là tắt dashboard.

- `AGENTS.md`: quy tắc chung cho mọi agent. `CLAUDE.md`: luật bổ sung cho lead.
- `.agents/tasks/`: file task (không commit). Mẫu: `.agents/tasks/_template.md`.
- `scripts/start-agents.sh`: dựng phiên tmux (lead = claude, workers = codex/gemini, mỗi worker một git worktree).
- `scripts/assign.sh <ID> <worker>`: lead giao task.
- `scripts/watch-tasks.sh`: chạy nền trong window `watch`, tự báo lead khi một task chuyển sang `done`/`blocked`
  (worker chỉ cần sửa dòng `Status:`, không phải tự gọi tmux, vì sandbox của Codex có thể chặn).
  `scripts/notify.sh <ID>` vẫn dùng được để báo tay.
- `scripts/dashboard.sh`: web dashboard ở http://localhost:7070.
  Xem bảng task theo Status, tạo task và giao cho worker, sửa file task, xem màn hình từng window
  tmux (lead, codex, ...) và gõ lệnh/phím vào đó, Start/Stop phiên agents. Chỉ cần Node, không cài gói npm.
  Điều khiển repo khác: `REPO=~/proj scripts/dashboard.sh`.

Chạy (trong WSL2/Linux, đã cài tmux, claude, codex):

    scripts/start-agents.sh        # hoặc WORKERS="codex gemini" scripts/start-agents.sh
    tmux attach -t agents

Lưu ý trên Windows: các file `.bat` dùng bản clone trong WSL (`~/Agent-Squad`), không phải bản trên ổ D:.
Làm việc trong WSL nhanh hơn nhiều so với `/mnt/d/...`. Mở thư mục đó từ Windows bằng
`\\wsl$\Ubuntu\home\<user>\Agent-Squad`, hoặc `code ~/Agent-Squad` trong Ubuntu.
