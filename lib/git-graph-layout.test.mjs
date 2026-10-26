import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { layoutGitGraph, lanePathD } = await jiti.import("./git-graph-layout.ts");

function commit(hash, parents = [], subject = hash) {
  return { hash, parents, refs: [], subject, authorName: null, authoredAtMs: null };
}

test("linear history collapses into one lane", () => {
  const layout = layoutGitGraph([
    commit("c3", ["c2"]),
    commit("c2", ["c1"]),
    commit("c1", []),
  ]);
  assert.equal(layout.laneCount, 1);
  assert.deepEqual(layout.rows.map((row) => row.laneIndex), [0, 0, 0]);
  // One path per child→parent edge.
  assert.equal(layout.paths.length, 2);
  assert.ok(layout.paths.every((path) => path.d.startsWith("M ")));
});

test("a fork and its merge fan out into two lanes and curve back", () => {
  // Newest first: A merges branch commit C into main line B; both meet at D.
  const layout = layoutGitGraph([
    commit("A", ["B", "C"]),
    commit("B", ["D"]),
    commit("C", ["D"]),
    commit("D", []),
  ]);
  assert.equal(layout.rows.length, 4);
  // The merge sits in lane 0, the side commit in its own lane.
  assert.equal(layout.rows[0].laneIndex, 0);
  assert.equal(layout.rows[1].laneIndex, 0);
  assert.equal(layout.rows[2].laneIndex, 1);
  assert.equal(layout.rows[3].laneIndex, 0);
  assert.equal(layout.laneCount, 2);
  // The merge link into D leaves the side lane and curves back to lane 0.
  const mergePath = layout.paths.find((path) =>
    path.relatedHashes.includes("C") && path.relatedHashes.includes("D"));
  assert.ok(mergePath, "expected a C→D path");
  assert.match(mergePath.d, /^M \d+ \d+ C /);
});

test("the first parent keeps the lane; the second gets its own", () => {
  // m1 merges m2 into its first-parent line b1←b2; both meet at m3.
  const layout = layoutGitGraph([
    commit("m1", ["b2", "m2"]),
    commit("b2", ["b1"]),
    commit("b1", ["m3"]),
    commit("m2", ["m3"]),
    commit("m3", []),
  ]);
  assert.equal(layout.laneCount, 2);
  // The first-parent chain holds lane 0 top to bottom.
  assert.equal(layout.rows[0].laneIndex, 0);
  assert.equal(layout.rows[1].laneIndex, 0);
  assert.equal(layout.rows[2].laneIndex, 0);
  // The merged-in parent sits beside it and curves back at the fork point.
  assert.equal(layout.rows[3].laneIndex, 1);
  assert.equal(layout.rows[4].laneIndex, 0);
  const mergePath = layout.paths.find((path) =>
    path.relatedHashes.includes("m2") && path.relatedHashes.includes("m3"));
  assert.ok(mergePath, "expected an m2→m3 path");
  assert.match(mergePath.d, /C /);
  // Every commit dot occupies a distinct (row, lane) cell.
  const seen = new Set(layout.rows.map((row) => `${row.rowIndex}:${row.laneIndex}`));
  assert.equal(seen.size, layout.rows.length);
});

test("a parent outside the loaded page truncates without a path", () => {
  const layout = layoutGitGraph([
    commit("c2", ["c1"]),
    commit("c1", ["unloaded"]),
  ]);
  // Only the loaded edge is drawn; the missing parent adds no path.
  assert.equal(layout.paths.length, 1);
  assert.deepEqual(layout.paths[0].relatedHashes, ["c2", "c1"]);
  assert.equal(layout.laneCount, 1);
});

test("appending an older page keeps the first page's lanes stable", () => {
  const firstPage = [
    commit("c3", ["c2"]),
    commit("c2", ["c1"]),
  ];
  const secondPage = [
    commit("c1", ["c0"]),
    commit("c0", []),
  ];
  const a = layoutGitGraph(firstPage);
  const b = layoutGitGraph([...firstPage, ...secondPage]);
  assert.deepEqual(
    b.rows.slice(0, a.rows.length).map((row) => row.laneIndex),
    a.rows.map((row) => row.laneIndex),
  );
});

test("empty input lays out as a single empty lane", () => {
  const layout = layoutGitGraph([]);
  assert.equal(layout.laneCount, 1);
  assert.deepEqual(layout.rows, []);
  assert.deepEqual(layout.paths, []);
  // Padding only: no rows to stack.
  assert.equal(layout.height, 38);
});

test("lanePathD is straight inside a lane and a Bézier across lanes", () => {
  assert.equal(lanePathD(10, 0, 10, 42, true), "M 10 0 L 10 42");
  const curve = lanePathD(10, 0, 28, 42, true);
  assert.equal(curve, "M 10 0 C 10 15.96, 28 15.96, 28 42");
  const hugged = lanePathD(28, 0, 10, 42, false);
  assert.equal(hugged, "M 28 0 C 28 26.04, 10 26.04, 10 42");
  // Short hops keep the minimum curve offset.
  assert.equal(lanePathD(10, 0, 28, 10, false), "M 10 0 C 10 -4, 28 -4, 28 10");
});
