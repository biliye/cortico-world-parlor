/**
 * Bradley–Terry MM fit, adapted from meow-ai-arena/arena/bt.py.
 * The upstream MIT license is included in LICENSE in this directory.
 */
export interface RankedSeat {
  cooId: string | null;
  rank: number;
  team: string | null;
}

export interface Rating {
  cooId: string;
  rating: number;
  games: number;
}

interface Pair {
  a: string;
  b: string;
  weight: number;
  wins: number;
}

function opponents(table: readonly RankedSeat[]): Pair[] {
  const pairs: Pair[] = [];
  for (const [index, seat] of table.entries()) {
    if (seat.cooId === null) continue;
    for (const other of table.slice(index + 1)) {
      if (other.cooId === null || seat.cooId === other.cooId) continue;
      if (seat.team !== null && seat.team === other.team) continue;
      const [a, b] = seat.cooId < other.cooId ? [seat, other] : [other, seat];
      pairs.push({
        a: a.cooId!, b: b.cooId!, weight: 1,
        wins: a.rank < b.rank ? 1 : a.rank === b.rank ? 0.5 : 0,
      });
    }
  }
  return pairs;
}

function fitComponent(ids: readonly string[], pairs: readonly Pair[]): number[] {
  const indices = new Map(ids.map((id, index) => [id, index]));
  const edges = pairs.map(pair => ({
    a: indices.get(pair.a)!, b: indices.get(pair.b)!,
    weight: pair.weight + 1, wins: pair.wins + 0.5,
  }));
  const wins = ids.map(() => 0);
  for (const edge of edges) {
    wins[edge.a]! += edge.wins;
    wins[edge.b]! += edge.weight - edge.wins;
  }
  let strength = ids.map(() => 1);
  for (let iteration = 0; iteration < 20_000; iteration++) {
    const denominator = ids.map(() => 0);
    for (const edge of edges) {
      const ratio = edge.weight / (strength[edge.a]! + strength[edge.b]!);
      denominator[edge.a]! += ratio;
      denominator[edge.b]! += ratio;
    }
    const logs = wins.map((value, i) => Math.log(value / denominator[i]!));
    const center = logs.reduce((sum, value) => sum + value, 0) / ids.length;
    let change = 0;
    strength = logs.map((value, i) => {
      const centered = value - center;
      change = Math.max(change, Math.abs(centered - Math.log(strength[i]!)));
      return Math.exp(centered);
    });
    if (change < 1e-10) break;
  }
  return strength.map(value => 400 * Math.log10(value));
}

/** 每种桌型人数的总权重相等。无有效配对的局既不加权，也不计入上榜局数。 */
export function fitRatings(tables: readonly (readonly RankedSeat[])[]): Rating[][] {
  const matches = tables.map(table => ({ size: table.length, pairs: opponents(table) }))
    .filter(match => match.pairs.length > 0);
  const counts = new Map<number, number>();
  for (const match of matches) counts.set(match.size, (counts.get(match.size) ?? 0) + 1);

  const games = new Map<string, number>();
  const adjacency = new Map<string, Pair[]>();
  const pairs = new Map<string, Pair>();
  for (const match of matches) {
    const weight = matches.length / (counts.size * counts.get(match.size)! * match.pairs.length);
    const players = new Set<string>();
    for (const pair of match.pairs) {
      players.add(pair.a).add(pair.b);
      const key = JSON.stringify([pair.a, pair.b]);
      let edge = pairs.get(key);
      if (!edge) {
        edge = { ...pair, weight: 0, wins: 0 };
        pairs.set(key, edge);
        for (const player of [edge.a, edge.b]) {
          const neighbors = adjacency.get(player) ?? [];
          neighbors.push(edge);
          adjacency.set(player, neighbors);
        }
      }
      edge.weight += weight;
      edge.wins += weight * pair.wins;
    }
    for (const player of players) games.set(player, (games.get(player) ?? 0) + 1);
  }

  // 不同连通组之间没有可比较的尺度。每组以几何平均强度为零分。
  const visited = new Set<string>();
  const groups: Rating[][] = [];
  for (const root of adjacency.keys()) {
    if (visited.has(root)) continue;
    const ids = [root];
    const edges = new Set<Pair>();
    visited.add(root);
    for (const id of ids) {
      for (const edge of adjacency.get(id)!) {
        edges.add(edge);
        const other = id === edge.a ? edge.b : edge.a;
        if (visited.has(other)) continue;
        visited.add(other);
        ids.push(other);
      }
    }
    const scores = fitComponent(ids, [...edges]);
    groups.push(ids.map((cooId, index) => ({
      cooId, rating: Math.round(scores[index]! * 10) / 10 || 0, games: games.get(cooId)!,
    })).sort((a, b) => b.rating - a.rating || b.games - a.games || a.cooId.localeCompare(b.cooId)));
  }
  return groups;
}
