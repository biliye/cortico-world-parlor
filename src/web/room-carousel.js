/** Only rotate server-visible rooms with more than ten seated people. */
export function createRoomCarousel(onChange, { interval = 6000, paused = false } = {}) {
  let rooms = [], index = 0, active = false, blocked = false, timer = null;
  const snapshot = () => ({ rooms, index, current: rooms[index] || null, paused });
  const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = () => {
    if (!active || blocked || paused || rooms.length < 2) { stop(); return; }
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; index = (index + 1) % rooms.length; onChange(snapshot()); schedule(); }, interval);
  };
  return {
    snapshot,
    setRooms(input) {
      const previous = rooms[index]?.id;
      rooms = input.filter(room => !room.archived && typeof room.id === 'string' && Number.isFinite(room.seats) && room.seats > 10);
      index = Math.max(0, rooms.findIndex(room => room.id === previous));
      onChange(snapshot()); schedule();
    },
    setActive(value) { active = !!value; schedule(); },
    setBlocked(value) { blocked = !!value; schedule(); },
    setPaused(value) { paused = !!value; onChange(snapshot()); schedule(); },
    select(next) {
      if (!Number.isInteger(next) || next < 0 || next >= rooms.length) return;
      index = next; stop(); onChange(snapshot()); schedule();
    },
    move(delta) { if (rooms.length) this.select((index + delta + rooms.length) % rooms.length); },
    dispose() { active = false; stop(); },
  };
}
