import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { commitGitFiles, COMMIT_MESSAGE_MAX_CHARS, COMMIT_PATHS_MAX } from "@/lib/git-commit";
import type { GitCommitRequest } from "@/lib/git-types";

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { cwd, paths, message, push } = (body ?? {}) as Partial<GitCommitRequest>;

    if (typeof cwd !== "string" || !cwd.trim() || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
      return NextResponse.json({ error: "paths must be an array of strings" }, { status: 400 });
    }
    if (typeof message !== "string") {
      return NextResponse.json({ error: "message must be a string" }, { status: 400 });
    }
    if (message.length > COMMIT_MESSAGE_MAX_CHARS) {
      return NextResponse.json({ error: "message is too long" }, { status: 400 });
    }
    if (paths.length > COMMIT_PATHS_MAX) {
      return NextResponse.json({ error: `Too many paths (max ${COMMIT_PATHS_MAX})` }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await commitGitFiles({
      cwd,
      paths,
      message,
      push: push === true,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
