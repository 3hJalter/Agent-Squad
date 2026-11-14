// Thư mục chung: phát hiện hai agent cùng sửa một file trong lúc cả hai còn đang làm việc.
// touched = { <agent>: { task, files: [...], at: <lúc ghi gần nhất> } } được lưu trong state.json; hàm này không đọc ghi đĩa.
'use strict';
const MAX = 300;

// Ghi nhận file agent `name` vừa đổi; trả về các file trùng với agent khác đang hoạt động.
function record(touched, name, taskId, files, isActive, now = Date.now()) {
  const mine = touched[name] && (!taskId || touched[name].task === taskId) ? touched[name] : { task: taskId || '', files: [] };
  if (taskId) mine.task = taskId;
  const clashes = [];
  for (const [other, t] of Object.entries(touched)) {
    if (other === name || !t || !Array.isArray(t.files)) continue;
    if (!isActive(other, t.task, t.at || 0)) { delete touched[other]; continue; } // agent kia đã xong việc: bỏ danh sách cũ
    const set = new Set(t.files);
    for (const f of files) if (set.has(f)) clashes.push({ file: f, other, task: t.task || '' });
  }
  mine.files = [...new Set([...mine.files, ...files])].slice(-MAX);
  mine.at = now;
  touched[name] = mine;
  return clashes;
}

module.exports = { record };
