export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const fallbackArea: Rectangle = { x: 0, y: 0, width: 620, height: 600 };

function isRectangle(value: unknown): value is Rectangle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rect = value as Rectangle;
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0
    && Number.isFinite(rect.x + rect.width) && Number.isFinite(rect.y + rect.height);
}

function validArea(value: unknown): Rectangle | undefined {
  if (!isRectangle(value)) return undefined;
  // Keep integer window coordinates completely inside even fractional areas.
  const x = Math.ceil(value.x), y = Math.ceil(value.y);
  const width = Math.floor(value.x + value.width) - x;
  const height = Math.floor(value.y + value.height) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : undefined;
}

export function fitWindowBounds(candidate: unknown, workAreas: Rectangle[], primaryArea: Rectangle): { bounds: Rectangle; workArea: Rectangle } {
  const primary = validArea(primaryArea) ?? { ...fallbackArea };
  const validCandidate = isRectangle(candidate);
  const requested: Rectangle = validCandidate ? candidate : { x: primary.x, y: primary.y, width: 620, height: 600 };
  let workArea = primary;
  let largestIntersection = 0;
  if (validCandidate) {
    for (const rawArea of workAreas) {
      const area = validArea(rawArea);
      if (!area) continue;
      const width = Math.max(0, Math.min(requested.x + requested.width, area.x + area.width) - Math.max(requested.x, area.x));
      const height = Math.max(0, Math.min(requested.y + requested.height, area.y + area.height) - Math.max(requested.y, area.y));
      const intersection = width * height;
      if (intersection > largestIntersection) { largestIntersection = intersection; workArea = area; }
    }
  }
  const width = Math.max(Math.min(520, workArea.width), Math.min(Math.round(requested.width), workArea.width));
  const height = Math.max(Math.min(480, workArea.height), Math.min(Math.round(requested.height), workArea.height));
  const x = Math.max(workArea.x, Math.min(Math.round(requested.x), workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(Math.round(requested.y), workArea.y + workArea.height - height));
  return { bounds: { x, y, width, height }, workArea };
}
