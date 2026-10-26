import type { GitGraphCommit } from "./git-types";

// Lane layout for a newest-first commit list: which lane (x column) each
// commit's dot sits in, and the stroke paths that connect children to
// parents. Reconstructed from ZCode's shipped renderer and reimplemented:
//
// - Every commit row reserves lanes in the order lines pass through it
//   (`nextLaneIndex`), so parallel branches fan out into neighbouring lanes
//   instead of overlapping.
// - A "branch line" walks one first-parent chain per pass. Its colour column
//   is reused once a previous line in that column has ended above the start
//   row, keeping the palette compact.
// - A merge whose next parent already sits on a branch connects along the
//   corridor that branch reserved through the rows in between, which draws
//   the familiar merge curve back into its parent's lane.
// - Parents outside the loaded page (older than the last row shown) become a
//   shared MISSING vertex: the walk simply stops, leaving a truncated edge.

export interface GitGraphLayoutOptions {
  rowHeight?: number;
  laneGap?: number;
  lanePadding?: number;
  topPadding?: number;
  bottomPadding?: number;
}

export interface GitGraphLaneRow {
  commit: GitGraphCommit;
  rowIndex: number;
  laneIndex: number;
  x: number;
  y: number;
}

export interface GitGraphLanePath {
  id: string;
  d: string;
  /** Palette slot for this path; cycles with the lane count. */
  colorIndex: number;
  /** The hashes this path connects: one when both ends are the same commit,
   *  two for a child→parent edge. Hovering either keeps the path lit. */
  relatedHashes: string[];
}

export interface GitGraphLayout {
  rows: GitGraphLaneRow[];
  paths: GitGraphLanePath[];
  laneCount: number;
  width: number;
  height: number;
  rowHeight: number;
  laneGap: number;
  lanePadding: number;
}

interface Point {
  laneIndex: number;
  rowIndex: number;
}

interface Connection {
  target: Vertex;
  branch: BranchLine;
}

class Vertex {
  readonly rowIndex: number;
  readonly hash: string;
  parents: Vertex[] = [];
  private nextParentIndex = 0;
  private laneIndex: number | null = null;
  private branch: BranchLine | null = null;
  private nextLaneIndex = 0;
  private connections: (Connection | undefined)[] = [];

  constructor(rowIndex: number, hash: string) {
    this.rowIndex = rowIndex;
    this.hash = hash;
  }

  nextParent(): Vertex | null {
    return this.nextParentIndex < this.parents.length ? this.parents[this.nextParentIndex] : null;
  }

  markParentProcessed(): void {
    this.nextParentIndex++;
  }

  isMerge(): boolean {
    return this.parents.length > 1;
  }

  isOnBranch(): boolean {
    return this.branch !== null && this.laneIndex !== null;
  }

  getBranch(): BranchLine | null {
    return this.branch;
  }

  joinBranch(branch: BranchLine, laneIndex: number): void {
    if (this.branch === null) {
      this.branch = branch;
      this.laneIndex = laneIndex;
    }
  }

  getLaneIndex(): number {
    return this.laneIndex ?? 0;
  }

  point(): Point {
    return { laneIndex: this.getLaneIndex(), rowIndex: this.rowIndex };
  }

  nextPoint(): Point {
    return { laneIndex: this.nextLaneIndex, rowIndex: this.rowIndex };
  }

  connectionTo(target: Vertex, branch: BranchLine): Point | null {
    const laneIndex = this.connections.findIndex((connection) =>
      connection?.target === target && connection.branch === branch);
    return laneIndex >= 0 ? { laneIndex, rowIndex: this.rowIndex } : null;
  }

  /** Take `laneIndex` for a pass-through toward `target`; only lanes handed
   *  out in order extend the row's used width. */
  reservePoint(laneIndex: number, target: Vertex, branch: BranchLine): void {
    if (laneIndex === this.nextLaneIndex) {
      this.connections[laneIndex] = { target, branch };
      this.nextLaneIndex = laneIndex + 1;
    }
  }

  /** Last lane index any line has taken in this row. */
  widestLaneIndex(): number {
    return this.nextLaneIndex - 1;
  }
}

class BranchLine {
  readonly colorIndex: number;
  endRowIndex = 0;
  readonly lines: {
    from: Point;
    to: Point;
    sourceHash: string;
    targetHash: string;
    lockedFirst: boolean;
  }[] = [];

  constructor(colorIndex: number) {
    this.colorIndex = colorIndex;
  }

  addLine(from: Point, to: Point, sourceHash: string, targetHash: string, lockedFirst: boolean): void {
    this.lines.push({ from, to, sourceHash, targetHash, lockedFirst });
  }
}

/** Parents older than the loaded page all share this vertex; no line is
 *  drawn to it, so its identity only needs to be unique. */
const MISSING = new Vertex(-1, "__missing_parent__");

function buildVertices(commits: GitGraphCommit[]): Vertex[] {
  const vertices = commits.map((commit, rowIndex) => new Vertex(rowIndex, commit.hash));
  const byHash = new Map(vertices.map((vertex) => [vertex.hash, vertex]));
  for (let i = 0; i < commits.length; i++) {
    for (const parentHash of commits[i].parents) {
      vertices[i].parents.push(byHash.get(parentHash) ?? MISSING);
    }
  }
  return vertices;
}

/** First colour column that ended above `startRow`, else a fresh column. */
function pickColorIndex(startRow: number, availableEndRows: number[]): number {
  const index = availableEndRows.findIndex((endRow) => endRow < startRow);
  if (index >= 0) return index;
  availableEndRows.push(0);
  return availableEndRows.length - 1;
}

/** Walk one first-parent chain from `startRow`, drawing its line downward
 *  through each row's next free lane until the parent is reached. When the
 *  parent was itself branchless it joins this line, and the walk continues
 *  with the parent's own next pending parent. */
function walkChain(startRow: number, vertices: Vertex[], branches: BranchLine[], availableEndRows: number[]): void {
  let head = vertices[startRow];
  let parent = head.nextParent();
  let point = head.isOnBranch() ? head.point() : head.nextPoint();
  const branch = new BranchLine(pickColorIndex(startRow, availableEndRows));
  head.joinBranch(branch, point.laneIndex);
  head.reservePoint(point.laneIndex, head, branch);

  let row = startRow + 1;
  for (; row < vertices.length && parent !== null && parent !== MISSING; row++) {
    const vertex = vertices[row];
    const reached = parent === vertex && vertex.isOnBranch();
    const target = reached ? vertex.point() : vertex.nextPoint();
    branch.addLine(point, target, head.hash, parent.hash, point.laneIndex < target.laneIndex);
    vertex.reservePoint(target.laneIndex, parent, branch);
    point = target;
    if (parent === vertex) {
      head.markParentProcessed();
      const wasOnBranch = vertex.isOnBranch();
      vertex.joinBranch(branch, target.laneIndex);
      head = vertex;
      parent = head.nextParent();
      if (parent === MISSING) {
        head.markParentProcessed();
        break;
      }
      if (parent === null || wasOnBranch) break;
    }
  }
  branch.endRowIndex = Math.min(row, vertices.length);
  branches.push(branch);
  availableEndRows[branch.colorIndex] = branch.endRowIndex;
}

/** A merge whose next parent already sits on a branch: connect along the
 *  corridor that branch reserved through the rows in between. */
function connectMergeParent(merge: Vertex, parent: Vertex, vertices: Vertex[]): void {
  const owning = parent.getBranch();
  if (!owning) {
    merge.markParentProcessed();
    return;
  }
  let point = merge.point();
  for (let row = merge.rowIndex + 1; row < vertices.length; row++) {
    const vertex = vertices[row];
    const connection = vertex.connectionTo(parent, owning);
    const found = connection !== null;
    const target = connection ?? vertex.nextPoint();
    owning.addLine(point, target, merge.hash, parent.hash, found || point.laneIndex < target.laneIndex);
    vertex.reservePoint(target.laneIndex, parent, owning);
    point = target;
    if (found) {
      merge.markParentProcessed();
      break;
    }
  }
}

export function layoutGitGraph(commits: GitGraphCommit[], options: GitGraphLayoutOptions = {}): GitGraphLayout {
  const rowHeight = options.rowHeight ?? 42;
  const laneGap = options.laneGap ?? 18;
  const lanePadding = options.lanePadding ?? 16;
  const topPadding = options.topPadding ?? 20;
  const bottomPadding = options.bottomPadding ?? 18;

  const vertices = buildVertices(commits);
  const branches: BranchLine[] = [];
  const availableEndRows: number[] = [];

  for (let row = 0; row < vertices.length;) {
    const vertex = vertices[row];
    const parent = vertex.nextParent();
    if (parent === null && vertex.isOnBranch()) {
      row++;
      continue;
    }
    if (parent === MISSING) {
      vertex.markParentProcessed();
      continue;
    }
    if (parent !== null && vertex.isMerge() && vertex.isOnBranch() && parent.isOnBranch()) {
      connectMergeParent(vertex, parent, vertices);
    } else {
      walkChain(row, vertices, branches, availableEndRows);
    }
  }

  const x = (laneIndex: number) => lanePadding + laneIndex * laneGap;
  const y = (rowIndex: number) => topPadding + rowIndex * rowHeight;

  const rows: GitGraphLaneRow[] = vertices.map((vertex, rowIndex) => ({
    commit: commits[rowIndex],
    rowIndex,
    laneIndex: vertex.getLaneIndex(),
    x: x(vertex.getLaneIndex()),
    y: y(rowIndex),
  }));

  const paths: GitGraphLanePath[] = [];
  let maxLaneIndex = -1;
  for (const row of rows) maxLaneIndex = Math.max(maxLaneIndex, row.laneIndex);
  for (const vertex of vertices) maxLaneIndex = Math.max(maxLaneIndex, vertex.widestLaneIndex());
  for (const branch of branches) {
    for (const line of branch.lines) {
      maxLaneIndex = Math.max(maxLaneIndex, line.from.laneIndex, line.to.laneIndex);
      paths.push({
        id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${paths.length}`,
        d: lanePathD(x(line.from.laneIndex), y(line.from.rowIndex), x(line.to.laneIndex), y(line.to.rowIndex), line.lockedFirst),
        colorIndex: branch.colorIndex,
        relatedHashes: line.sourceHash === line.targetHash
          ? [line.sourceHash]
          : [line.sourceHash, line.targetHash],
      });
    }
  }
  const laneCount = Math.max(1, maxLaneIndex + 1);

  return {
    rows,
    paths,
    laneCount,
    width: lanePadding * 2 + (laneCount - 1) * laneGap,
    height: topPadding + Math.max(0, commits.length - 1) * rowHeight + bottomPadding,
    rowHeight,
    laneGap,
    lanePadding,
  };
}

/** Straight while inside one lane; a cubic Bézier otherwise, hugging the end
 *  the line is anchored to (`lockedFirst`), so parent links curve the way git
 *  graphs usually do. */
export function lanePathD(fromX: number, fromY: number, toX: number, toY: number, lockedFirst: boolean): string {
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  const offset = Math.max(14, Math.abs(toY - fromY) * 0.38);
  if (!lockedFirst) {
    return `M ${fromX} ${fromY} C ${fromX} ${toY - offset}, ${toX} ${toY - offset}, ${toX} ${toY}`;
  }
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + offset}, ${toX} ${fromY + offset}, ${toX} ${toY}`;
}
