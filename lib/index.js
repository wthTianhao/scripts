/**
 * dsh-session-sync — a DSH host plugin registering the `/sync` slash command.
 *
 * It moves the DSH conversation data between machines:
 *   - `push`  : flush every live session to disk, mirror `$DSH_HOME/sessions`
 *               (+ `attachments`) into `target`, then `git add/commit/push`.
 *   - `pull`  : `git pull` in `target`, then copy sessions/attachments back
 *               into `$DSH_HOME` (overwrites existing, never deletes
 *               local-only sessions).
 *   - `status`: show home, target, git remote/branch, and item counts.
 *   - `init`  : create `target` and `git init` it when git mode is on.
 *
 * The plugin uses only Node builtins (no runtime dependencies). It is mounted
 * as a plain profile row; see the repo README for the `cordis.patch.yml`
 * entry and the manual install layout under the profile's `node_modules`.
 *
 * @module dsh-session-sync
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Stable Cordis plugin name. */
const name = "session-sync";
/** Services required before the command can be registered. */
const inject = ["commands", "sessions"];
/** Human-facing usage line. */
const USAGE = "/sync [push|pull|status|init]";

/* ── config ─────────────────────────────────────────────────────────────── */

/** Resolve the harness home the same way dsh-home-paths does. */
function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim().length > 0) return resolve(env.trim());
  return join(homedir(), ".dsh");
}

/**
 * Normalize the row config with safe defaults.
 * @param raw - the raw config object from the patch row (may be undefined).
 */
function configOf(raw) {
  const c = raw !== null && typeof raw === "object" ? raw : {};
  const home = resolveHome();
  const rawTarget = c.target;
  const target = rawTarget !== undefined && String(rawTarget).trim() !== ""
    ? resolve(String(rawTarget).trim())
    : join(home, "dsh-sync");
  return {
    home,
    target,
    git: c.git !== false,
    pushRemote: c.pushRemote !== false,
    pullRemote: c.pullRemote !== false,
    copyAttachments: c.copyAttachments !== false,
    branch: c.branch !== undefined ? String(c.branch) : undefined
  };
}

/* ── filesystem helpers ─────────────────────────────────────────────────── */

/**
 * Mirror `src` into `dst`: copy every entry, then remove entries present in
 * `dst` but absent in `src`. Returns entry counts.
 */
function mirrorDir(src, dst) {
  if (!existsSync(src)) return { copied: 0, removed: 0 };
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  let removed = 0;
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dst, entry);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, force: true });
    copied += 1;
  }
  for (const entry of readdirSync(dst)) {
    if (!existsSync(join(src, entry))) {
      rmSync(join(dst, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  return { copied, removed };
}

/**
 * Recursive non-destructive merge of `src` into `dst`: directories are merged
 * entry by entry, files replace the same-named destination, and entries that
 * exist only in `dst` are kept. Used by pull so local-only sessions survive
 * inside a project directory that also exists in the target.
 * @returns the number of top-level entries processed.
 */
function mergeDir(src, dst) {
  if (!existsSync(src)) return { merged: 0 };
  mkdirSync(dst, { recursive: true });
  let merged = 0;
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dst, entry);
    if (statSync(from).isDirectory()) {
      mergeDir(from, to);
    } else {
      if (existsSync(to)) rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { force: true });
    }
    merged += 1;
  }
  return { merged };
}

/** Count the immediate subdirectories of `dir` (0 when absent). */
function dirCount(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

/* ── git helpers ────────────────────────────────────────────────────────── */

/** Run one git command; never throws. */
function gitRun(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const detail = error !== null && typeof error === "object" && "stderr" in error && error.stderr
      ? String(error.stderr).trim()
      : error !== null && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    return { ok: false, error: detail };
  }
}

/** Whether `dir` is a git working tree. */
function isGitRepo(dir) {
  if (!existsSync(dir)) return false;
  return existsSync(join(dir, ".git")) || gitRun(["rev-parse", "--is-inside-work-tree"], dir).ok;
}

/** Guard against a target that would recursively sync into itself. */
function targetSafetyError(cfg) {
  if (resolve(cfg.target) === resolve(cfg.home)) {
    return `target 不能是 DSH_HOME 本身（${cfg.home}）`;
  }
  if (resolve(cfg.target) === resolve(join(cfg.home, "sessions"))) {
    return "target 不能是 sessions 目录本身";
  }
  return undefined;
}

/* ── command verbs ──────────────────────────────────────────────────────── */

/** `/sync push`: flush, mirror, git commit + push. */
async function pushToTarget(ctx, cfg, signal) {
  const guard = targetSafetyError(cfg);
  if (guard !== undefined) return { kind: "error", text: guard };

  const steps = [];

  // 1. Make every live session durable before copying anything.
  let flushed = 0;
  if (ctx !== null && typeof ctx === "object" && ctx.sessions !== undefined) {
    try {
      for (const session of ctx.sessions.list()) {
        signal?.throwIfAborted();
        await ctx.sessions.flush(session);
        flushed += 1;
      }
    } catch (error) {
      return { kind: "error", text: `刷新会话到磁盘失败（已复制 ${flushed} 个）: ${String(error)}` };
    }
  }
  steps.push(`已刷新 ${flushed} 个活跃会话`);

  // 2. Mirror sessions (and attachments) into the target.
  const sessions = mirrorDir(join(cfg.home, "sessions"), join(cfg.target, "sessions"));
  steps.push(`sessions: 镜像 ${sessions.copied} 个会话目录（清理 ${sessions.removed} 个）`);
  if (cfg.copyAttachments) {
    const att = mirrorDir(join(cfg.home, "attachments"), join(cfg.target, "attachments"));
    steps.push(`attachments: 镜像 ${att.copied} 项`);
  }

  // 3. Git commit + push when git mode is on.
  if (cfg.git) {
    if (!isGitRepo(cfg.target)) {
      return {
        kind: "error",
        text: `${cfg.target} 不是 git 仓库。先运行 /sync init（或手动在该目录 git init 并添加 remote）`
      };
    }
    const status = gitRun(["status", "--porcelain"], cfg.target);
    if (!status.ok) return { kind: "error", text: `git status 失败: ${status.error}` };
    if (status.out.trim() === "") {
      steps.push("git: 无改动，跳过提交");
    } else {
      const add = gitRun(["add", "-A"], cfg.target);
      if (!add.ok) return { kind: "error", text: `git add 失败: ${add.error}` };
      const message = `dsh session sync ${new Date().toISOString()}`;
      const commit = gitRun(["commit", "-m", message], cfg.target);
      if (!commit.ok) return { kind: "error", text: `git commit 失败（可能需要先配置 user.name/user.email）: ${commit.error}` };
      steps.push(`git: 已提交 "${message}"`);
      if (cfg.pushRemote) {
        const push = gitRun(["push"], cfg.target);
        if (!push.ok) return { kind: "error", text: `git push 失败（请检查 remote/网络）: ${push.error}` };
        steps.push("git: 已推送");
      }
    }
  } else {
    steps.push("git: 已关闭（纯目录镜像，适用于云盘同步目录）");
  }
  return { kind: "success", text: [`/sync push 完成`, ...steps].join("\n") };
}

/** `/sync pull`: git pull, then copy sessions/attachments back into home. */
async function pullFromTarget(ctx, cfg, signal) {
  const guard = targetSafetyError(cfg);
  if (guard !== undefined) return { kind: "error", text: guard };

  const steps = [];
  if (cfg.git) {
    if (!isGitRepo(cfg.target)) {
      return { kind: "error", text: `${cfg.target} 不是 git 仓库，无法 pull` };
    }
    if (cfg.pullRemote) {
      const pull = gitRun(["pull"], cfg.target);
      if (!pull.ok) {
        const hint = pull.error.includes("tracking information")
          ? "\n提示：当前分支没有 upstream，先执行 git branch --set-upstream-to=origin/<分支名> <分支名>（或首次 clone 后直接 push 建立追踪）"
          : "";
        return { kind: "error", text: `git pull 失败: ${pull.error}${hint}` };
      }
      steps.push("git: 已拉取");
    } else {
      steps.push("git: pullRemote 已关闭，跳过 git pull");
    }
  } else {
    steps.push("git: 已关闭（从目录直接复制）");
  }

  const sessions = mergeDir(join(cfg.target, "sessions"), join(cfg.home, "sessions"));
  steps.push(`sessions: 合并 ${sessions.merged} 项`);
  if (cfg.copyAttachments) {
    const att = mergeDir(join(cfg.target, "attachments"), join(cfg.home, "attachments"));
    steps.push(`attachments: 合并 ${att.merged} 项`);
  }
  steps.push("提示：pull 覆盖已有文件、不删除本机独有会话；若本机有未 push 的改动，请先 /sync push");
  return { kind: "success", text: [`/sync pull 完成`, ...steps].join("\n") };
}

/** `/sync init`: create the target and initialize a git repository. */
function initTarget(cfg) {
  const guard = targetSafetyError(cfg);
  if (guard !== undefined) return { kind: "error", text: guard };
  mkdirSync(cfg.target, { recursive: true });
  const steps = [`target: ${cfg.target}（已就绪）`];
  if (cfg.git) {
    if (isGitRepo(cfg.target)) {
      steps.push("git: 已是仓库，跳过初始化");
    } else {
      const branchArgs = cfg.branch !== undefined ? ["init", "-b", cfg.branch] : ["init", "-b", "main"];
      const init = gitRun(branchArgs, cfg.target);
      if (!init.ok) return { kind: "error", text: `git init 失败: ${init.error}` };
      steps.push(`git: 已初始化（分支 ${cfg.branch ?? "main"}）`);
      steps.push("下一步：在 target 目录里配置远程，例如 git remote add origin <你的私有仓库地址>");
    }
  } else {
    steps.push("git: 已关闭（纯目录，无需初始化）");
  }
  return { kind: "success", text: steps.join("\n") };
}

/** `/sync status`: show config, git state, and item counts. */
function statusOf(cfg) {
  const lines = [
    `DSH_HOME: ${cfg.home}`,
    `target:   ${cfg.target}`,
    `git:      ${cfg.git ? "on" : "off"}（pushRemote=${cfg.pushRemote} / pullRemote=${cfg.pullRemote}）`,
    `copyAttachments: ${cfg.copyAttachments}`
  ];
  lines.push(`本地 sessions 会话目录数: ${dirCount(join(cfg.home, "sessions"))}`);
  lines.push(`target sessions 会话目录数: ${dirCount(join(cfg.target, "sessions"))}`);
  if (cfg.git && isGitRepo(cfg.target)) {
    const remote = gitRun(["remote", "-v"], cfg.target);
    lines.push(`remote: ${remote.ok && remote.out !== "" ? remote.out.split("\n")[0] : "（未配置）"}`);
    const branch = gitRun(["branch", "--show-current"], cfg.target);
    lines.push(`branch: ${branch.ok && branch.out !== "" ? branch.out : "（无）"}`);
    const last = gitRun(["log", "-1", "--format=%h %cd %s", "--date=short"], cfg.target);
    lines.push(`last commit: ${last.ok && last.out !== "" ? last.out : "（尚无提交）"}`);
    const ahead = gitRun(["status", "-sb"], cfg.target);
    if (ahead.ok) lines.push(`工作树: ${ahead.out.split("\n")[0]}`);
  } else if (cfg.git) {
    lines.push("target 尚未初始化为 git 仓库（/sync init）");
  }
  return { kind: "success", text: lines.join("\n") };
}

/* ── plugin entry ───────────────────────────────────────────────────────── */

/**
 * Register the `/sync` command.
 * @param ctx - Cordis context carrying `commands` (and `sessions` when live).
 * @param config - the row config (`target`, `git`, `pushRemote`, `pullRemote`,
 *   `copyAttachments`, `branch`).
 */
function apply(ctx, config) {
  const cfg = configOf(config);
  ctx.commands.register({
    name: "sync",
    description: "同步 DSH 会话与附件到 git 仓库或云盘目录（push/pull/status/init）",
    input: { hint: "[push|pull|status|init]" },
    handler: async (invocation) => {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      const verb = (parts[0] ?? "status").toLowerCase();
      try {
        switch (verb) {
          case "push": return await pushToTarget(ctx, cfg, invocation.signal);
          case "pull": return await pullFromTarget(ctx, cfg, invocation.signal);
          case "init": return initTarget(cfg);
          case "status": return statusOf(cfg);
          default: return { kind: "error", text: `未知子命令 /sync ${verb}\n${USAGE}` };
        }
      } catch (error) {
        return { kind: "error", text: `/sync ${verb} 失败: ${String(error)}` };
      }
    }
  });
}

export { USAGE, apply, configOf, dirCount, gitRun, inject, isGitRepo, mergeDir, mirrorDir, name, pullFromTarget, pushToTarget, resolveHome, statusOf };
