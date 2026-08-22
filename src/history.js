"use strict";
/**
 * history.js — 会话历史折叠：把 SessionEvent[] 折叠成聊天消息列表。
 * 纯函数，便于单测；供「打开历史会话」「重启后恢复记录」使用。
 */

/** 从 ContentBlock[] 中提取纯文本。 */
function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * 折叠事件流为 [{role:'user'|'assistant', text}]。
 * 只取 user/message 与 assistant/message 的文本；工具调用不单独渲染（可在工具卡片区补充）。
 */
function foldHistory(events) {
  const messages = [];
  for (const ev of events || []) {
    if (!ev || !ev.type || !ev.data) continue;
    if (ev.type === "user/message") {
      const text = contentText(ev.data.content);
      if (text) messages.push({ role: "user", text });
    } else if (ev.type === "assistant/message") {
      const text = contentText(ev.data.message && ev.data.message.content);
      if (text) messages.push({ role: "assistant", text });
    }
  }
  return messages;
}

module.exports = { foldHistory, contentText };
