import proj4 from "proj4";
import graphData from "../../data/graph.json";

proj4.defs(
  "EPSG:5181",
  "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs"
);

type RawNode = [number, number, 0 | 1]; // [lon, lat, hasSignal]
type RawLink = {
  road: string;
  length: number;
  u: string;
  v: string;
  coords: [number, number][];
  profile: ([number, number] | null)[]; // 168 entries, idx = dow*24+hour
};
type RawGraph = { nodes: Record<string, RawNode>; links: Record<string, RawLink> };

const raw = graphData as unknown as RawGraph;

export type NodeInfo = { lon: number; lat: number; hasSignal: number };
export type LinkInfo = {
  id: number;
  road: string;
  length: number;
  u: string;
  v: string;
  coords: [number, number][];
  profile: ([number, number] | null)[];
};

export const NODES: Record<string, NodeInfo> = {};
export const NODE_NAMES: string[] = Object.keys(raw.nodes);
for (const name of NODE_NAMES) {
  const [lon, lat, hasSignal] = raw.nodes[name];
  NODES[name] = { lon, lat, hasSignal };
}

export const LINKS_BY_ID = new Map<number, LinkInfo>();
for (const [idStr, l] of Object.entries(raw.links)) {
  const id = Number(idStr);
  LINKS_BY_ID.set(id, { id, road: l.road, length: l.length, u: l.u, v: l.v, coords: l.coords, profile: l.profile });
}

// 스냅용: 모든 노드를 EPSG:5181(미터 단위 TM)로 미리 투영해서 선형 탐색에 사용
const NODE_XY: { name: string; x: number; y: number }[] = NODE_NAMES.map((name) => {
  const { lon, lat } = NODES[name];
  const [x, y] = proj4("EPSG:4326", "EPSG:5181", [lon, lat]);
  return { name, x, y };
});

export function snap(lon: number, lat: number): { node: string; distM: number } {
  const [x, y] = proj4("EPSG:4326", "EPSG:5181", [lon, lat]);
  let bestName = NODE_XY[0].name;
  let bestD2 = Infinity;
  for (const p of NODE_XY) {
    const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestName = p.name;
    }
  }
  return { node: bestName, distM: Math.sqrt(bestD2) };
}

type Edge = { to: string; link: number; length: number; mean?: number; p90?: number };

let staticLengthGraph: Map<string, Edge[]> | null = null;

function buildStaticLengthGraph(): Map<string, Edge[]> {
  if (staticLengthGraph) return staticLengthGraph;
  const adj = new Map<string, Edge[]>();
  for (const link of LINKS_BY_ID.values()) {
    const edges = adj.get(link.u) ?? [];
    edges.push({ to: link.v, link: link.id, length: link.length });
    adj.set(link.u, edges);
  }
  staticLengthGraph = adj;
  return adj;
}

const timeGraphCache = new Map<string, Map<string, Edge[]>>();

function buildTimeGraph(dow: number, hour: number): Map<string, Edge[]> {
  const key = `${dow}_${hour}`;
  const cached = timeGraphCache.get(key);
  if (cached) return cached;

  const slot = dow * 24 + hour;
  const adj = new Map<string, Edge[]>();
  for (const link of LINKS_BY_ID.values()) {
    const prof = link.profile[slot];
    if (!prof) continue;
    const edges = adj.get(link.u) ?? [];
    edges.push({ to: link.v, link: link.id, length: link.length, mean: prof[0], p90: prof[1] });
    adj.set(link.u, edges);
  }
  timeGraphCache.set(key, adj);
  return adj;
}

class MinHeap {
  private heap: { key: number; node: string }[] = [];

  get size() {
    return this.heap.length;
  }

  push(key: number, node: string) {
    const heap = this.heap;
    heap.push({ key, node });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].key <= heap[i].key) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  }

  pop(): { key: number; node: string } | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const n = heap.length;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && heap[l].key < heap[smallest].key) smallest = l;
        if (r < n && heap[r].key < heap[smallest].key) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function dijkstra(
  adj: Map<string, Edge[]>,
  src: string,
  dst: string,
  weightOf: (e: Edge) => number
): { nodes: string[]; links: number[] } | null {
  if (src === dst) return { nodes: [src], links: [] };

  const dist = new Map<string, number>([[src, 0]]);
  const prevNode = new Map<string, string>();
  const prevLink = new Map<string, number>();
  const visited = new Set<string>();
  const heap = new MinHeap();
  heap.push(0, src);

  while (heap.size > 0) {
    const top = heap.pop()!;
    if (visited.has(top.node)) continue;
    visited.add(top.node);
    if (top.node === dst) break;

    const edges = adj.get(top.node);
    if (!edges) continue;
    for (const e of edges) {
      const nd = top.key + weightOf(e);
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prevNode.set(e.to, top.node);
        prevLink.set(e.to, e.link);
        heap.push(nd, e.to);
      }
    }
  }

  if (!dist.has(dst)) return null;

  const nodesRev: string[] = [dst];
  const linksRev: number[] = [];
  let cur = dst;
  while (cur !== src) {
    const link = prevLink.get(cur);
    const prev = prevNode.get(cur);
    if (link === undefined || prev === undefined) return null;
    linksRev.push(link);
    cur = prev;
    nodesRev.push(cur);
  }

  return { nodes: nodesRev.reverse(), links: linksRev.reverse() };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export type RouteDetail = {
  dist_km: number;
  signals: number;
  roads: string[];
  coords: [number, number][];
  est_min: number;
  est_p90_min: number;
};

export type WeightKind = "length" | "mean" | "p90";

export function buildRoute(src: string, dst: string, weight: WeightKind, dow: number, hour: number): RouteDetail | null {
  const adj = weight === "length" ? buildStaticLengthGraph() : buildTimeGraph(dow, hour);
  const weightOf = (e: Edge) => (weight === "length" ? e.length : weight === "mean" ? e.mean! : e.p90!);

  const path = dijkstra(adj, src, dst, weightOf);
  if (!path) return null;

  const slot = dow * 24 + hour;
  let distM = 0;
  let sumMean = 0;
  let sumP90 = 0;
  const roads: string[] = [];
  const coords: [number, number][] = [];

  for (const lid of path.links) {
    const link = LINKS_BY_ID.get(lid);
    if (!link) continue;
    distM += link.length;
    if (!roads.includes(link.road)) roads.push(link.road);
    const prof = link.profile[slot];
    if (prof) {
      sumMean += prof[0];
      sumP90 += prof[1];
    }
    coords.push(...link.coords);
  }

  let signals = 0;
  for (const n of path.nodes.slice(1, -1)) {
    signals += NODES[n]?.hasSignal ?? 0;
  }

  return {
    dist_km: round1(distM / 1000),
    signals,
    roads: roads.slice(0, 5),
    coords,
    est_min: round1(sumMean / 60),
    est_p90_min: round1(sumP90 / 60),
  };
}

// ---------------------------------------------------------------------------
// 카카오 경로를 우리 그래프로 역매핑(맵매칭)해서, "카카오가 고른 길을 우리
// 모델로 계산하면 몇 분인가"를 구한다. 같은 모델·같은 시간대 기준으로
// buildRoute(weight="mean"/"p90") 결과와 공정 비교하기 위함.
// ---------------------------------------------------------------------------

const STEP_M = 25; // 카카오 폴리라인 리샘플 간격
const TOLERANCE_M = 25; // 이 거리 이내에 있는 세그먼트만 매칭으로 인정
const GRID_CELL_M = 150; // 세그먼트 공간 인덱스 격자 크기
const FALLBACK_SPEED_KMH = 25; // 매칭 안 된(갭) 구간의 가정 속도 — 모델값 아님

type Segment = { x1: number; y1: number; x2: number; y2: number; linkId: number };

let segmentIndex: Map<string, Segment[]> | null = null;

function cellKey(x: number, y: number): string {
  return `${Math.floor(x / GRID_CELL_M)},${Math.floor(y / GRID_CELL_M)}`;
}

function buildSegmentIndex(): Map<string, Segment[]> {
  if (segmentIndex) return segmentIndex;
  const idx = new Map<string, Segment[]>();
  const addTo = (key: string, seg: Segment) => {
    const arr = idx.get(key);
    if (arr) arr.push(seg);
    else idx.set(key, [seg]);
  };
  for (const link of LINKS_BY_ID.values()) {
    const pts = link.coords.map(([lon, lat]) => proj4("EPSG:4326", "EPSG:5181", [lon, lat]) as [number, number]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const seg: Segment = { x1, y1, x2, y2, linkId: link.id };
      const keys = new Set([cellKey(x1, y1), cellKey(x2, y2), cellKey((x1 + x2) / 2, (y1 + y2) / 2)]);
      for (const k of keys) addTo(k, seg);
    }
  }
  segmentIndex = idx;
  return idx;
}

function pointSegDist(px: number, py: number, seg: Segment): number {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = seg.x1 + t * dx;
  const cy = seg.y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function nearestLink(x: number, y: number, idx: Map<string, Segment[]>): number | null {
  const gx = Math.floor(x / GRID_CELL_M);
  const gy = Math.floor(y / GRID_CELL_M);
  let best: number | null = null;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const segs = idx.get(`${gx + dx},${gy + dy}`);
      if (!segs) continue;
      for (const seg of segs) {
        const d = pointSegDist(x, y, seg);
        if (d < bestD) {
          bestD = d;
          best = seg.linkId;
        }
      }
    }
  }
  return bestD <= TOLERANCE_M ? best : null;
}

export type KakaoMatchResult = {
  coverage_pct: number;
  dist_km: number;
  signals: number;
  roads: string[];
  est_min: number;
  est_p90_min: number;
};

export function matchKakaoRoute(coords: [number, number][], dow: number, hour: number): KakaoMatchResult | null {
  if (coords.length < 2) return null;
  const idx = buildSegmentIndex();
  const slot = dow * 24 + hour;

  const pts = coords.map(([lon, lat]) => proj4("EPSG:4326", "EPSG:5181", [lon, lat]) as [number, number]);

  let totalDistM = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    totalDistM += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  if (totalDistM === 0) return null;

  // STEP_M 간격으로 리샘플
  const samples: { x: number; y: number }[] = [{ x: pts[0][0], y: pts[0][1] }];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const segLen = Math.hypot(x2 - x1, y2 - y1);
    if (segLen === 0) continue;
    let d = carry;
    while (d < segLen) {
      const t = d / segLen;
      samples.push({ x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) });
      d += STEP_M;
    }
    carry = d - segLen;
  }

  // 연속 샘플을 링크별 run으로 묶기 (미매칭 샘플은 linkId=-1)
  type Run = { linkId: number; count: number };
  const runs: Run[] = [];
  for (const s of samples) {
    const key = nearestLink(s.x, s.y, idx) ?? -1;
    const last = runs[runs.length - 1];
    if (last && last.linkId === key) last.count++;
    else runs.push({ linkId: key, count: 1 });
  }

  const linkRawDist = new Map<number, number>();
  for (const r of runs) {
    if (r.linkId === -1) continue;
    linkRawDist.set(r.linkId, (linkRawDist.get(r.linkId) ?? 0) + r.count * STEP_M);
  }

  let sumMean = 0;
  let sumP90 = 0;
  let matchedDist = 0;
  const roads: string[] = [];
  const seenRoads = new Set<string>();
  const processedLinks = new Set<number>();

  for (const r of runs) {
    if (r.linkId === -1 || processedLinks.has(r.linkId)) continue;
    processedLinks.add(r.linkId);
    const link = LINKS_BY_ID.get(r.linkId);
    if (!link) continue;
    const prof = link.profile[slot];
    if (!prof) continue; // 해당 요일·시간대 모델 추정치 없음 → 갭으로 취급

    const rawDist = linkRawDist.get(r.linkId)!;
    const cappedDist = Math.min(rawDist, link.length);
    const ratio = cappedDist / link.length;
    sumMean += prof[0] * ratio;
    sumP90 += prof[1] * ratio;
    matchedDist += cappedDist;
    if (!seenRoads.has(link.road) && roads.length < 5) {
      roads.push(link.road);
      seenRoads.add(link.road);
    }
  }

  // 신호 교차로: 매칭(+모델 추정치 있는) 링크들의 노드 순서를 따라 집계
  const nodeSeq: string[] = [];
  for (const r of runs) {
    if (r.linkId === -1) continue;
    const link = LINKS_BY_ID.get(r.linkId);
    if (!link || !link.profile[slot]) continue;
    if (nodeSeq[nodeSeq.length - 1] !== link.u) nodeSeq.push(link.u);
    nodeSeq.push(link.v);
  }
  let signals = 0;
  for (const n of nodeSeq.slice(1, -1)) signals += NODES[n]?.hasSignal ?? 0;

  // 매칭 안 된(갭) 거리는 고정 가정 속도로 채움 — 모델 추정치가 아님을 명시
  const gapDist = Math.max(0, totalDistM - matchedDist);
  const gapTimeSec = gapDist / ((FALLBACK_SPEED_KMH * 1000) / 3600);
  sumMean += gapTimeSec;
  sumP90 += gapTimeSec;

  const coverage_pct = Math.max(0, Math.min(100, Math.round((100 * matchedDist) / totalDistM)));

  return {
    coverage_pct,
    dist_km: round1(totalDistM / 1000),
    signals,
    roads,
    est_min: round1(sumMean / 60),
    est_p90_min: round1(Math.max(sumMean, sumP90) / 60),
  };
}
