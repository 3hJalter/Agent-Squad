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
  (trên dashboard: "⚙ Cài đặt" > "Đội agent"; danh sách model/effort ở `dashboard/catalog.json`).
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
- Bố cục: cột trái là project và danh sách agent (bấm để mở chat), giữa là chat, cột phải là Tasks. Mọi mục cài đặt
  nằm trong nút **⚙ Cài đặt** ở góc dưới cột trái, chia tab: "Đội agent" (một bảng duy nhất, kèm cây phân cấp), "Cách làm việc", "Quyền",
  "Tài khoản", "Tài nguyên", "Token", "Hệ thống" (thông báo, cập nhật, khởi động lại).
  Tab **🔐 Quyền** (kiểu Chat): xem quyền đã cấp thêm cho từng agent, thu hồi từng quyền, hoặc cho phép trước theo nhóm
  (Python, .NET / Unity, cài thư viện npm, tải từ mạng, git push; với Codex là quyền mạng). Vẫn là bạn tự bấm, không có chế độ bỏ qua toàn bộ.
- Trong chat: các bước agent làm gom thành một dòng ("Đã làm 6 bước · sửa 2 file"), mỗi bước ghi bằng lời, bấm vào mới thấy câu lệnh.
  Ảnh hiện thẳng trong chat; bấm ảnh hoặc thẻ file thì mở ở cột phải (file `.md` hiện dạng tài liệu), bấm ✕ để quay lại Tasks.
- Thư mục làm việc của agent (project Code, kiểu Chat; chọn trong "⚙ Cài đặt" > "Cách làm việc"):
  - **Chung một thư mục** (mặc định cho project mới): mọi agent làm thẳng trong thư mục project, cùng một nhánh, không có bước "Gộp code".
    Hợp với project Unity hoặc đội ít agent. Agent được dặn chỉ sửa file của task mình và chỉ commit file của mình.
  - **Mỗi agent một bản riêng**: mỗi worker có một git worktree và nhánh `agent/<tên>` trong `<project>-agents/<tên>` (bản tạo kiểu cũ
    `<project>-<tên>` vẫn dùng tiếp), làm xong thì "Gộp code".
  - Bấm "Chung một thư mục" trên project đang chạy kiểu bản riêng: dashboard commit việc đang dở của từng agent, merge các nhánh `agent/<tên>`
    vào thư mục chính rồi bỏ các worktree. Xung đột thì dừng lại và báo, không xoá gì.
- Bộ nhớ (kiểu Chat, tab "🧠 Bộ nhớ" trong Cài đặt):
  - **Bộ nhớ chung** `.agents/memory.md`: quyết định, quy ước, sở thích của bạn. Agent được dặn ghi thêm một dòng khi bạn chốt điều gì;
    nội dung được đưa vào đầu mọi cuộc trò chuyện mới của mọi agent. Xem và sửa được trong tab.
  - **Ghi chú riêng của từng agent** `.agents/handoff/<tên>.md`: việc đang dở. Được ghi khi đổi tài khoản / model, khi tự làm mới,
    khi bấm "Cập nhật ngay"; "Cuộc trò chuyện mới" giữ lại một bản tóm tắt từ lịch sử chat nếu chưa có ghi chú gần đây.
  - **Tự làm mới cuộc trò chuyện**: khi cuộc trò chuyện của một agent Claude vượt ngưỡng (mặc định 120k token, chỉnh hoặc tắt trong tab)
    và có việc mới (bạn nhắn hoặc nhận task), agent ghi ghi chú rồi làm việc đó trong cuộc trò chuyện mới. Codex / Gemini chưa đo được độ dài.
  - context-mode không phải bộ nhớ: nó chỉ giữ dữ liệu lớn ở ngoài cuộc trò chuyện.
- Khung chat (kiểu Chat): câu trả lời của agent Claude hiện dần từng đoạn khi agent đang viết (Codex / Gemini hiện khi xong đoạn).
  Bấm vào thẻ file trong chat để mở file ở cột phải; nút "Thay đổi" cho xem dòng nào được thêm (xanh), bỏ (đỏ) so với lần lưu git gần nhất.
- Kiểu hiển thị (trong "⚙ Cài đặt" > "Cách làm việc"):
  - **💬 Chat** (mặc định, `dashboard/chat.js`): agent chạy ẩn (`claude -p`, `codex exec`, `gemini -p`), dashboard hiện
    tin nhắn dạng chat với các bước làm thu gọn được. Lead giao việc bằng `Status: ready`, dashboard tự chạy worker
    và báo lead khi task xong. Quyền ban đầu an toàn: sửa file trong project, chạy lệnh git và lệnh kiểm tra, Codex
    không có mạng. Khi agent bị chặn, tin nhắn có nút "Cho phép & làm tiếp" (cấp đúng lệnh/công cụ đó, hoặc quyền mạng
    cho Codex); thu hồi ở mục "Nâng cao". Lịch sử ở `.agents/chat/`. Không cần tmux.
    Thẻ xin quyền chỉ ghi tên quyền dễ hiểu ("chạy Python", "công cụ .NET"), câu lệnh nằm trong "Chi tiết". Nếu máy chưa đặt tên/email git,
    dashboard đặt sẵn theo tên agent để agent không cần `git -c user.name=…` (dạng lệnh đó không khớp quyền "git commit").
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
  - **🤖 Đội agent**: trước khi Start là bảng chọn Lead và worker; khi đang chạy là cây phân cấp, kéo thả để đổi cấp trên (ghi vào `.agents/hierarchy.txt`); ở kiểu Chat còn thêm,
    đổi tên, đổi model/effort và xoá agent (cấp dưới chuyển lên cấp trên, task đang giữ về Todo, worktree được giữ lại).
  - **Tiết kiệm token**: khi task xong hoặc bị chặn, dashboard chép sẵn phần Result vào tin báo cho cấp trên (không phải mở file) và gộp
    các task xong cùng lúc vào một tin. Thẻ task hiện số token quy đổi đã dùng cho task đó. Bảng "Đội agent" có nút điền nhanh
    Tiết kiệm / Cân bằng / Mạnh (chỉ điền vào bảng, bạn vẫn bấm Lưu).
  - **📊 Token**: số token mỗi agent đã dùng và tỉ lệ % theo Claude / Codex / Gemini (kiểu Chat, lưu ở `.agents/chat/usage.json`).
    Số lấy từ báo cáo của chính CLI sau mỗi lượt, tách thành Mới / Đệm (đọc lại từ bộ nhớ đệm) / Trả lời; cột "Quy đổi" = Mới + Đệm/10 + Trả lời
    và % tính theo cột này. Claude: chia theo model thực chạy (gồm agent phụ), lượt bị dừng vẫn cộng phần đã dùng (đánh dấu ước tính).
    "Xem số liệu gốc" hiện nguyên báo cáo của lượt gần nhất để đối chiếu. Không biết hạn mức còn lại của gói đang dùng.
  - **👤 Tài khoản**: hồ sơ đăng nhập riêng cho Claude và Codex (ChatGPT), lưu ở `~/.agent-squad/accounts/<hồ sơ>/` (Claude dùng `CLAUDE_CONFIG_DIR`,
    Codex dùng `CODEX_HOME`). Mỗi hồ sơ đăng nhập một lần bằng dòng lệnh dashboard hiện sẵn; chọn hồ sơ cho từng agent ở 🤖 Đội agent > Sửa,
    các agent dùng tài khoản khác nhau chạy song song được. Khi hồ sơ tạo mới chỉ chép cài đặt cơ bản, không chép đăng nhập.
    Đổi tài khoản hoặc model thì agent bắt đầu cuộc trò chuyện mới; mặc định agent **ghi bộ nhớ ra `.agents/handoff/<tên>.md` trước khi đổi** và đọc lại sau đó
    (nếu agent không ghi được, ví dụ hết hạn mức, dashboard lấy phần cuối lịch sử chat thay thế). Nút "💾 Cập nhật bộ nhớ ngay" ghi bộ nhớ bất cứ lúc nào.
    Bảng Token hiện theo tài khoản. Gemini chưa hỗ trợ.
  - **⚡ context-mode** (thử nghiệm, "Cách làm việc", tắt mặc định, theo project): agent Claude nạp MCP server
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
