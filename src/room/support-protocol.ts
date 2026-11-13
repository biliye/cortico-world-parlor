export interface Feedback {
  id: string; coo_id: string; name: string; text: string; created_at: number; reply: string; status: string;
}
export interface Announcement {
  id: string; text: string; created_at: number;
  /** schema 9 起：编辑次数与最后编辑时刻（老行按 1 / 0 读）。 */
  revision?: number;
  updated_at?: number;
}
