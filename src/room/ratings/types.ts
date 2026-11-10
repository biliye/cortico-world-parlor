export interface RatingBoard {
  game: string;
  since: number | null;
  minGames: number;
  mine: { games: number; rating: number | null };
  groups: { rows: { name: string; position: number; games: number; rating: number; mine: boolean }[] }[];
  truncated: boolean;
}
