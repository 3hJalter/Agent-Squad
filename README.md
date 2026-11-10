# Agent-Squad

Khung điều phối nhiều agent (lead + workers) để tiết kiệm token.

**Trên Windows (sau khi đã chạy xong 1→3 trong `windows/`): double-click `Agent-Squad.bat`.**
Cập nhật bản mới: double-click `Update.bat` (hoặc nút "⟳ Cập nhật" trên dashboard).
File này cập nhật code trong WSL và mở dashboard thành cửa sổ riêng; bấm "Start agents" trên dashboard để bật agent.
Để nguyên cửa sổ thu nhỏ "Agent-Squad server" trên taskbar; đóng nó là tắt dashboard.

- `AGENTS.md`: quy tắc chung cho mọi agent. `CLAUDE.md`: luật bổ sung cho lead.
- `.agents/tasks/`: file task (không commit). Mẫu: `.agents/tasks/_template.md`.
- `scripts/start-agents.sh`: dựng phiên tmux (lead và workers là claude/codex/gemini, mỗi worker một git worktree).
  Mỗi agent viết `[<tên>=]<agent>[@<model>][#<effort>]` (tên chỉ cho worker, để phân biệt nhiều worker cùng model), ví dụ
  `LEAD="codex@gpt-6.1-sol#high" WORKERS="claude@opus#xhigh gemini@gemini-3.5-flash" scripts/start-agents.sh`
  (trên dashboard: nút "Chọn agent & model"; danh sách model/effort ở `dashboard/catalog.json`).
  Lead không gọi được tmux (ví dụ Codex trong sandbox) thì đặt `Status: ready`, `watch-tasks.sh` sẽ tự giao.
- `scripts/assign.sh <ID> <worker>`: lead giao task.
- `scripts/watch-tasks.sh`: chạy nền trong window `watch`, tự báo lead khi một task chuyển sang `done`/`blocked`
  (worker chỉ cần sửa dòng `Status:`, không phải tự gọi tmux, vì sandbox của Codex có thể chặn).
  `scripts/notify.sh <ID>` vẫn dùng được để báo tay.
- `scripts/dashboard.sh`: web dashboard ở http://localhost:7070.
  Xem bảng task theo Status, nhờ lead chia việc hoặc tự tạo task và giao cho worker, đính kèm file/ảnh (lưu vào `.agents/uploads/`), sửa file task, xem màn hình từng window
  tmux (lead, codex, ...) và gõ lệnh/phím vào đó, Start/Stop phiên agents. Chỉ cần Node, không cài gói npm.
  Nhiều project: nút "+ Project" (duyệt thư mục, hộp thoại chọn thư mục của Windows, hoặc gõ `~/app` / `D:\Web\app`);
  thư mục chưa là repo thì tự `git init` + commit đầu. Mỗi project một phiên tmux riêng, danh sách lưu ở
  `~/.agent-squad/projects.json` (xoá khỏi danh sách không xoá file). Dashboard tự tạo file khung nếu repo chưa có.
- Kiểu hiển thị (trong "Chọn agent & model"):
  - **💬 Chat** (mặc định, `dashboard/chat.js`): agent chạy ẩn (`claude -p`, `codex exec`, `gemini -p`), dashboard hiện
    tin nhắn dạng chat với các bước làm thu gọn được. Lead giao việc bằng `Status: ready`, dashboard tự chạy worker
    và báo lead khi task xong. Quyền ban đầu an toàn: sửa file trong project, chạy lệnh git và lệnh kiểm tra, Codex
    không có mạng. Khi agent bị chặn, tin nhắn có nút "Cho phép & làm tiếp" (cấp đúng lệnh/công cụ đó, hoặc quyền mạng
    cho Codex); thu hồi ở mục "Nâng cao". Lịch sử ở `.agents/chat/`. Không cần tmux.
  - **🖥 Terminal**: như cũ, mỗi agent một window tmux, dashboard hiện màn hình terminal.

Chạy (trong WSL2/Linux, đã cài tmux, claude, codex):

    scripts/start-agents.sh        # hoặc WORKERS="codex gemini" scripts/start-agents.sh
    tmux attach -t agents

Lưu ý trên Windows: các file `.bat` dùng bản clone trong WSL (`~/Agent-Squad`), không phải bản trên ổ D:.
Làm việc trong WSL nhanh hơn nhiều so với `/mnt/d/...`. Mở thư mục đó từ Windows bằng
`\\wsl$\Ubuntu\home\<user>\Agent-Squad`, hoặc `code ~/Agent-Squad` trong Ubuntu.
