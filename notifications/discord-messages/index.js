import * as core from "@actions/core";

const MESSAGE = Bun.env.MESSAGE ?? "yo";
const WEBHOOK_URL = Bun.env.WEBHOOK_URL;
const BOT_NAME = Bun.env.BOT_NAME ?? "Discord Bot";
const AVATAR_URL = Bun.env.AVATAR_URL ?? "";

async function sendMessage() {
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: BOT_NAME,
        avatar_url: AVATAR_URL,
        content: MESSAGE,
      }),
    });
  } catch (e) {
    console.log(`Unable to send message: ${e}`);
    core.setFailed(`Unable to send message: ${e}`);
  }
}

try {
  if (!MESSAGE || WEBHOOK_URL) {
    core.setFailed("Message and Webhook URL are required");
  } else {
    await sendMessage();
  }
} catch (e) {
  console.log(e);
}
