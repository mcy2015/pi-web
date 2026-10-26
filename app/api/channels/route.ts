// GET  /api/channels  — the Channels settings' status: the Telegram
//                       section's config (token only as a last-4 hint), the
//                       loop's health, and the last unknown chat for pairing.
// POST /api/channels  — config changes and one-off actions, each restarting
//                       the loop to match. The token is accepted here and
//                       never echoed back whole. More channels follow the
//                       same sectioned store (lib/telegram/config-store.ts).

import { NextResponse, type NextRequest } from "next/server";
import { getMe, sendMessage } from "@/lib/telegram/bot-api";
import {
  editTelegramConfig,
  readTelegramConfig,
  tokenHint,
} from "@/lib/telegram/config-store";
import type { TelegramAllowedChat } from "@/lib/telegram/types";
import { getTelegramStatus, syncTelegramRuntime } from "@/lib/telegram/runtime";

export async function GET() {
  try {
    return NextResponse.json(getTelegramStatus());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

interface SetTokenBody { token?: unknown }
interface EnabledBody { enabled?: unknown }
interface DefaultCwdBody { cwd?: unknown }
interface ChatIdBody { chatId?: unknown; title?: unknown }
interface TestSendBody { chatId?: unknown; text?: unknown }

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function POST(req: NextRequest) {
  let action: string | undefined;
  try {
    const body = await req.json() as { action?: unknown } & Record<string, unknown>;
    action = typeof body.action === "string" ? body.action : undefined;
    switch (action) {
      case "set-token": {
        const token = asTrimmedString((body as SetTokenBody).token);
        if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
          return NextResponse.json({ error: "That does not look like a bot token (expected <numbers>:<characters>)." }, { status: 400 });
        }
        // Validate against Telegram before saving: a typo is caught here,
        // not as a dead loop later.
        try {
          await getMe(token);
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
        }
        const config = await editTelegramConfig((current) => ({
          config: { ...current, token },
          changed: true,
        }));
        await syncTelegramRuntime();
        return NextResponse.json({ success: true, tokenHint: tokenHint(config.token) });
      }
      case "remove-token": {
        await editTelegramConfig((current) => ({
          config: { ...current, token: "", enabled: false },
          changed: true,
        }));
        await syncTelegramRuntime();
        return NextResponse.json({ success: true });
      }
      case "set-enabled": {
        const enabled = (body as EnabledBody).enabled === true;
        const config = readTelegramConfig();
        if (enabled && config.token === "") {
          return NextResponse.json({ error: "Set a bot token first." }, { status: 400 });
        }
        await editTelegramConfig((current) => ({
          config: { ...current, enabled },
          changed: true,
        }));
        await syncTelegramRuntime();
        return NextResponse.json({ success: true });
      }
      case "set-default-cwd": {
        const cwd = asTrimmedString((body as DefaultCwdBody).cwd);
        await editTelegramConfig((current) => ({
          config: { ...current, defaultCwd: cwd },
          changed: true,
        }));
        return NextResponse.json({ success: true });
      }
      case "allow-chat": {
        const chatId = (body as ChatIdBody).chatId;
        const title = asTrimmedString((body as ChatIdBody).title);
        if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
          return NextResponse.json({ error: "chatId must be an integer." }, { status: 400 });
        }
        await editTelegramConfig((current) => {
          if (current.allowedChats.some((chat) => chat.id === chatId)) {
            return { config: current, changed: false };
          }
          const allowedChats: TelegramAllowedChat[] = [...current.allowedChats, { id: chatId, title, cwd: null }];
          return { config: { ...current, allowedChats }, changed: true };
        });
        return NextResponse.json({ success: true });
      }
      case "set-chat-cwd": {
        const chatId = (body as ChatIdBody).chatId;
        const cwd = asTrimmedString((body as DefaultCwdBody).cwd);
        if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
          return NextResponse.json({ error: "chatId must be an integer." }, { status: 400 });
        }
        await editTelegramConfig((current) => {
          if (!current.allowedChats.some((chat) => chat.id === chatId)) {
            return { config: current, changed: false };
          }
          const allowedChats = current.allowedChats.map((chat) => chat.id === chatId ? { ...chat, cwd } : chat);
          return { config: { ...current, allowedChats }, changed: true };
        });
        return NextResponse.json({ success: true });
      }
      case "remove-chat": {
        const chatId = (body as ChatIdBody).chatId;
        if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
          return NextResponse.json({ error: "chatId must be an integer." }, { status: 400 });
        }
        await editTelegramConfig((current) => ({
          config: { ...current, allowedChats: current.allowedChats.filter((chat) => chat.id !== chatId) },
          changed: true,
        }));
        return NextResponse.json({ success: true });
      }
      case "test-send": {
        const config = readTelegramConfig();
        if (config.token === "") {
          return NextResponse.json({ error: "Set a bot token first." }, { status: 400 });
        }
        const chatId = (body as TestSendBody).chatId;
        if (typeof chatId !== "number" || !config.allowedChats.some((chat) => chat.id === chatId)) {
          return NextResponse.json({ error: "Pick an allowlisted chat." }, { status: 400 });
        }
        const text = asTrimmedString((body as TestSendBody).text) ?? "Pi Web test message ✅";
        try {
          await sendMessage(config.token, chatId, text);
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
        }
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
