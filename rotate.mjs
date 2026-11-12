export function beginRotate(flag, point) {
  return {
    x: flag.x,
    y: flag.y,
    startRoll: flag.roll,
    angle: Math.atan2(point.y - flag.y, point.x - flag.x),
    delta: 0,
  };
}
export function rotateFromPointer(state, point, snap = false) {
  if (Math.hypot(point.x - state.x, point.y - state.y) < 1e-6) return state.startRoll - state.delta;
  const angle = Math.atan2(point.y - state.y, point.x - state.x);
  state.delta += Math.atan2(Math.sin(angle - state.angle), Math.cos(angle - state.angle));
  state.angle = angle;
  let roll = state.startRoll - state.delta;
  if (snap) roll = Math.round(roll / (Math.PI / 12)) * (Math.PI / 12);
  return Math.atan2(Math.sin(roll), Math.cos(roll));
}
