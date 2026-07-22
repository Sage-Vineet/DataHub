export const POINTER_DRAG_THRESHOLD_PX = 3;

export function shouldStartCanvasDrag(startClientPoint = {}, currentClientPoint = {}, threshold = POINTER_DRAG_THRESHOLD_PX) {
  const startX = Number(startClientPoint.x ?? startClientPoint.clientX ?? 0);
  const startY = Number(startClientPoint.y ?? startClientPoint.clientY ?? 0);
  const currentX = Number(currentClientPoint.x ?? currentClientPoint.clientX ?? 0);
  const currentY = Number(currentClientPoint.y ?? currentClientPoint.clientY ?? 0);
  return Math.hypot(currentX - startX, currentY - startY) >= threshold;
}
