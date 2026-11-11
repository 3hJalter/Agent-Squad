# Agent-Squad

Khung điều phối nhiều agent (lead + workers) để tiết kiệm token.

**Trên Windows (sau khi đã chạy xong 1→3 trong `windows/`): double-click `Agent-Squad.bat`.**
Cập nhật bản mới: double-click `Update.bat` (hoặc nút "⟳ Cập nhật" trên dashboard).
File này cập nhật code trong WSL và mở dashboard thành cửa sổ riêng; bấm "Start agents" trên dashboard để bật agent.
Để nguyên cửa sổ thu nhỏ "Agent-Squad server" trên taskbar; đóng nó là tắt dashboard.
Nâng cấp chính Agent-Squad bằng agent: chọn project Agent-Squad trên dashboard, nhờ Lead làm và gộp code, rồi bấm
"↻ Khởi động lại" (dashboard chạy thử bản mới trước; bản lỗi thì giữ nguyên bản đang chạy).
Ổ C: đầy? `windows/5-move-wsl-to-D.bat` chuyển cả Ubuntu (project, worker, công cụ) sang `D:\WSL\Ubuntu`, giữ nguyên dữ liệu.

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
    Agent được dặn chỉ báo ngắn gọn khi xong / bị chặn / cần hỏi; lời nói giữa chừng nằm trong mục "bước đã làm".
    Agent có thể xin tạo agent cấp dưới (file `.agents/requests/<tên>.md`); dashboard hiện thẻ để bạn "Cho phép tạo" hoặc "Từ chối",
    agent mới được ghi vào `.agents/hierarchy.txt` dưới quyền agent đã xin.
    Ảnh và file: dán, kéo thả hoặc đính kèm vào ô nhắn (lưu ở `.agents/uploads/`, tối đa 20 MB); ảnh và file agent nhắc tới
    hoặc vừa sửa hiện ngay trong chat, bấm để xem hoặc tải về (chỉ mở được file trong project).
  - **🗂 Project điều hành** ("+ Project" > "Điều hành (không git)"): thư mục chỉ chứa task, chat và quy ước, không có git, không có bản sao riêng
    cho từng worker (mọi agent làm ngay trong đó). Chỉ chạy ở kiểu Chat. Dữ liệu thật (code, tài liệu, dữ liệu) ở nơi khác trên máy.
  - **📁 Tài nguyên** (mọi loại project): folder hoặc file bạn khai báo để agent đọc và **sửa tại chỗ** (không chỉ đọc, không nhánh, không bước gộp).
    Lưu trong `~/.agent-squad/projects.json`, đổi xong áp dụng từ lượt nhắn sau. Nhận ra project Unity (Assets + ProjectSettings): thêm quy ước
    cho agent (không đụng Library/Temp, giữ file .meta) và nút tạo `.gitignore` Unity khi repo chưa có.
  - **🔀 Agent git** (project điều hành): tự có một agent tên `git` (Claude, model haiku) là agent duy nhất chạy commit/pull/merge/push trong các
    thư mục tài nguyên; Lead giao việc cho nó bằng task `Owner: git`. Các agent khác bị dặn không chạy git ở đó. Push vẫn cần bạn bấm "Cho phép".
    Không dùng Codex cho agent này vì sandbox của Codex không ghi được `.git`.
  - **🌳 Agents**: xem cây phân cấp, kéo thả để đổi cấp trên (ghi vào `.agents/hierarchy.txt`); ở kiểu Chat còn thêm,
    đổi tên, đổi model/effort và xoá agent (cấp dưới chuyển lên cấp trên, task đang giữ về Todo, worktree được giữ lại).
  - **📊 Token**: số token mỗi agent đã dùng và tỉ lệ % theo Claude / Codex / Gemini (kiểu Chat, lưu ở `.agents/chat/usage.json`).
  - **⚡ context-mode** (thử nghiệm, "Chọn agent & model", tắt mặc định, theo project): agent Claude nạp MCP server
    [mksglu/context-mode](https://github.com/mksglu/context-mode) (`npx -y context-mode`, cần Node.js 22.5+) để dữ liệu lớn (log dài, nhiều file) không đổ hết vào ngữ cảnh.
    Chỉ cho Claude, đổi xong áp dụng từ lượt sau. Rủi ro: nó cho agent chạy code trong ô riêng, nằm ngoài danh sách lệnh an toàn và nút "Cho phép"
    (dashboard hỏi lại khi bật). Bảng Token đánh dấu ⚡ và có cột TB/lượt để so sánh trước và sau.
  - **🔔 Báo**: tiếng và thông báo trình duyệt khi task xong, bị chặn, agent cần quyền hoặc Lead trả lời xong.
  - Kéo thanh giữa khung task và chat để đổi độ rộng, kéo thanh trên ô nhắn để đổi chiều cao (bấm đúp để về mặc định).
  - **🖥 Terminal**: như cũ, mỗi agent một window tmux, dashboard hiện màn hình terminal.

Chạy (trong WSL2/Linux, đã cài tmux, claude, codex):

    scripts/start-agents.sh        # hoặc WORKERS="codex gemini" scripts/start-agents.sh
    tmux attach -t agents

Lưu ý trên Windows: các file `.bat` dùng bản clone trong WSL (`~/Agent-Squad`), không phải bản trên ổ D:.
Làm việc trong WSL nhanh hơn nhiều so với `/mnt/d/...`. Mở thư mục đó từ Windows bằng
`\\wsl$\Ubuntu\home\<user>\Agent-Squad`, hoặc `code ~/Agent-Squad` trong Ubuntu.
