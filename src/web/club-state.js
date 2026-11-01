/** Browser-only preferences. Server snapshots never own drafts, panels or favorites. */
export function createClubState(storage, namespace = 'parlor-club-v1') {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(namespace) || '{}') || {}; } catch { /* unavailable storage */ }
  const data = {
    chatOpen: saved.chatOpen !== false,
    mobileChatOpen: saved.mobileChatOpen === true,
    favorites: Array.isArray(saved.favorites) ? saved.favorites.filter(id => typeof id === 'string') : [],
    drafts: saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts) ? saved.drafts : {},
  };
  const persist = () => { try { storage.setItem(namespace, JSON.stringify(data)); } catch { /* memory still works */ } };
  return {
    get chatOpen() { return data.chatOpen; },
    setChatOpen(value) { data.chatOpen = !!value; persist(); },
    get mobileChatOpen() { return data.mobileChatOpen; },
    setMobileChatOpen(value) { data.mobileChatOpen = !!value; persist(); },
    isFavorite(id) { return data.favorites.includes(id); },
    toggleFavorite(id) {
      data.favorites = data.favorites.includes(id) ? data.favorites.filter(value => value !== id) : [...data.favorites, id];
      persist();
    },
    draft(key) { return typeof data.drafts[key] === 'string' ? data.drafts[key] : ''; },
    saveDraft(key, text) {
      if (text) data.drafts[key] = String(text).slice(0, 400);
      else delete data.drafts[key];
      persist();
    },
  };
}

export const conversationKey = (identity, room, channel, table = '') => JSON.stringify([
  identity || '', room || '', channel, channel === 'table' ? table : '',
]);

export function readRoute(search) {
  const params = new URLSearchParams(search);
  return { room: params.get('room') || '', view: params.get('view') === 'table' ? 'table' : 'lobby', table: params.get('table') || '' };
}

export function routeUrl(room, view, table = '') {
  const params = new URLSearchParams();
  if (room) params.set('room', room);
  if (view === 'table') { params.set('view', 'table'); if (table) params.set('table', table); }
  return '/play' + (params.size ? '?' + params : '');
}
