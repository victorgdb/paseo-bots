import { join } from "node:path";
import { botDataPath } from "./bot-home";
import { writeInside } from "./safe-fs";

export async function saveUpload({ botId, fileName, dataBase64 }: { botId: string; fileName: string; dataBase64: string }) {
  const safe = fileName.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "") || "file";
  const dir = join(botDataPath(botId), "uploads");
  const path = join(dir, `${Date.now().toString(36)}-${safe}`);
  const bytes = Buffer.from(dataBase64, "base64");
  await writeInside(botDataPath(botId), path, bytes);
  return { path, size: bytes.length };
}
