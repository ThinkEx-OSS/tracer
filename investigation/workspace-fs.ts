import type { getInvestigationSandbox } from "./sandbox";
import { shellQuote } from "./shell";

type Sandbox = ReturnType<typeof getInvestigationSandbox>;

type EntryType = "file" | "directory" | "symlink";

/**
 * Structurally matches `FileInfo` from `@cloudflare/shell` (the shape the Think
 * workspace tools and codemode `state.*` backend expect). We redeclare it here
 * because `@cloudflare/shell` is a transitive dependency of `@cloudflare/think`
 * and is not directly importable from application code.
 */
interface WorkspaceFileInfo {
  path: string;
  name: string;
  type: EntryType;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  target?: string;
}

const FS_EXEC_TIMEOUT_MS = 60_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function basename(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function dirname(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  return trimmed.slice(0, index);
}

function mimeForFile(path: string) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "text/plain";
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "text/plain";
}

function mapType(fileType: string): EntryType {
  if (fileType.includes("directory")) return "directory";
  if (fileType.includes("symbolic link")) return "symlink";
  return "file";
}

function mimeForType(type: EntryType, path: string) {
  if (type === "directory") return "inode/directory";
  if (type === "symlink") return "inode/symlink";
  return mimeForFile(path);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A `WorkspaceLike` / `WorkspaceFsLike` filesystem backed by a live
 * `@cloudflare/sandbox` container. Wiring this into a Think agent's
 * `this.workspace` makes the built-in file tools (`read`/`write`/`edit`/
 * `list`/`find`/`grep`/`delete`) and codemode's `state.*` operate on the real
 * repository checkout inside the container instead of the empty DO-SQLite
 * virtual filesystem.
 *
 * Direct container file operations (read/write/mkdir/exists/move) use the
 * sandbox RPC methods; metadata operations (stat/glob/readlink/readdir) use a
 * single `sandbox.exec` shell command each to avoid round-trip storms.
 */
export class SandboxWorkspace {
  private readonly getSandbox: () => Sandbox;
  private readonly rootDir: string;

  constructor(getSandbox: () => Sandbox, rootDir: string) {
    this.getSandbox = getSandbox;
    this.rootDir = rootDir;
  }

  private async exec(command: string, cwd = this.rootDir) {
    return this.getSandbox().exec(command, { cwd, timeout: FS_EXEC_TIMEOUT_MS });
  }

  async readFile(path: string): Promise<string | null> {
    if (!(await this.exists(path))) return null;
    const result = await this.getSandbox().readFile(path, { encoding: "utf-8" });
    return result.content;
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    if (!(await this.exists(path))) return null;
    const result = await this.getSandbox().readFile(path, { encoding: "base64" });
    return base64ToBytes(result.content);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureParent(path);
    await this.getSandbox().writeFile(path, content, { encoding: "utf-8" });
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.ensureParent(path);
    await this.getSandbox().writeFile(path, bytesToBase64(content), { encoding: "base64" });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const existing = (await this.readFile(path)) ?? "";
    const addition = typeof content === "string" ? content : new TextDecoder().decode(content);
    await this.writeFile(path, existing + addition);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.getSandbox().exists(path);
    return result.exists;
  }

  async stat(path: string): Promise<WorkspaceFileInfo | null> {
    return this.statInternal(path, true);
  }

  async lstat(path: string): Promise<WorkspaceFileInfo | null> {
    return this.statInternal(path, false);
  }

  private async statInternal(path: string, follow: boolean): Promise<WorkspaceFileInfo | null> {
    if (!(await this.exists(path))) return null;
    const deref = follow ? "-L " : "";
    const result = await this.exec(`stat ${deref}-c '%F|%s|%Y' -- ${shellQuote(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to inspect ${path}`);
    }
    const [rawType, rawSize, rawMtime] = result.stdout.trim().split("|");
    const type = mapType(rawType ?? "");
    const mtimeMs = (Number(rawMtime) || 0) * 1_000;
    const info: WorkspaceFileInfo = {
      path,
      name: basename(path),
      type,
      mimeType: mimeForType(type, path),
      size: Number(rawSize) || 0,
      createdAt: mtimeMs,
      updatedAt: mtimeMs,
    };
    if (type === "symlink") {
      const target = await this.readlink(path).catch(() => "");
      if (target) info.target = target;
    }
    return info;
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.getSandbox().mkdir(path, { recursive: opts?.recursive ?? false });
  }

  async readDir(
    dir: string = this.rootDir,
    opts?: { limit?: number; offset?: number },
  ): Promise<WorkspaceFileInfo[]> {
    if (!(await this.exists(dir))) return [];
    const listing = await this.getSandbox().listFiles(dir, {});
    const offset = opts?.offset ?? 0;
    const entries = listing.files.slice(
      offset,
      opts?.limit === undefined ? undefined : offset + opts.limit,
    );
    return entries.map((entry) => {
      const type: EntryType =
        entry.type === "directory" ? "directory" : entry.type === "symlink" ? "symlink" : "file";
      const mtimeMs = Date.parse(entry.modifiedAt) || 0;
      return {
        path: entry.absolutePath,
        name: entry.name,
        type,
        mimeType: mimeForType(type, entry.absolutePath),
        size: entry.size,
        createdAt: mtimeMs,
        updatedAt: mtimeMs,
      };
    });
  }

  async glob(pattern: string): Promise<WorkspaceFileInfo[]> {
    const script =
      "shopt -s globstar nullglob dotglob extglob 2>/dev/null; " +
      'for f in $1; do stat -L -c "%F|%s|%Y|%n" -- "$f" 2>/dev/null || ' +
      'stat -c "%F|%s|%Y|%n" -- "$f"; done';
    const result = await this.exec(`bash -c ${shellQuote(script)} bash ${shellQuote(pattern)}`);
    if (!result.stdout.trim()) return [];
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        // Format: "%F|%s|%Y|%n" — the path (%n) may itself contain "|".
        const parts = line.split("|");
        const type = mapType(parts[0] ?? "");
        const rawPath = parts.slice(3).join("|");
        const absolute = rawPath.startsWith("/") ? rawPath : `${this.rootDir}/${rawPath}`;
        const mtimeMs = (Number(parts[2]) || 0) * 1_000;
        return {
          path: absolute,
          name: basename(absolute),
          type,
          mimeType: mimeForType(type, absolute),
          size: Number(parts[1]) || 0,
          createdAt: mtimeMs,
          updatedAt: mtimeMs,
        } satisfies WorkspaceFileInfo;
      })
      .filter((entry) => entry.path.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const flags = [opts?.recursive ? "-r" : "", opts?.force ? "-f" : ""].filter(Boolean).join(" ");
    const result = await this.exec(`rm ${flags} -- ${shellQuote(path)}`.replace(/\s+/g, " "));
    if (result.exitCode !== 0 && !opts?.force) {
      throw new Error(result.stderr.trim() || `Failed to remove ${path}`);
    }
  }

  async cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    const flags = opts?.recursive ? "-r" : "";
    const result = await this.exec(
      `cp ${flags} -- ${shellQuote(src)} ${shellQuote(dest)}`.replace(/\s+/g, " "),
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Failed to copy ${src}`);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.getSandbox().moveFile(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const result = await this.exec(`ln -s -- ${shellQuote(target)} ${shellQuote(linkPath)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to symlink ${linkPath}`);
    }
  }

  async readlink(path: string): Promise<string> {
    const result = await this.exec(`readlink -- ${shellQuote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Not a symlink: ${path}`);
    return result.stdout.trim();
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = dirname(path);
    if (parent && parent !== "." && parent !== "/") {
      await this.getSandbox()
        .mkdir(parent, { recursive: true })
        .catch(() => undefined);
    }
  }
}
