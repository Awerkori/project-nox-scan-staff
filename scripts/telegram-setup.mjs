// Operator-only. Never print bot tokens or raw Telegram responses.
import { readFileSync } from "node:fs";
const token = readFileSync("/tmp/nox-staff-telegram-bot-token.secret", "utf8").trim();
async function call(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
  return data.result;
}
try {
  const me = await call("getMe");
  console.log(JSON.stringify({ bot: me.username, id: me.id }));
  if (process.argv[2] === "channel") {
    const channel = await call("getChat", { chat_id: "-1004440522630" });
    if (channel.title !== "STAFF SCAN" || channel.type !== "channel") throw new Error("Unexpected target");
    const member = await call("getChatMember", { chat_id: channel.id, user_id: me.id });
    console.log(JSON.stringify({ channel: channel.title, chatId: channel.id, status: member.status,
      canPost: member.can_post_messages, canDelete: member.can_delete_messages, canPromote: member.can_promote_members }));
  }
  const updates = await call("getUpdates", { allowed_updates: ["my_chat_member", "channel_post"], limit: 100 });
  for (const update of updates) {
    const event = update.my_chat_member || update.channel_post;
    if (event?.chat?.title === "STAFF SCAN")
      console.log(JSON.stringify({ channel: event.chat.title, chatId: event.chat.id, botStatus: event.new_chat_member?.status }));
  }
} catch {
  console.error("Telegram setup check failed. Provider details suppressed to protect secrets.");
  process.exitCode = 1;
}
