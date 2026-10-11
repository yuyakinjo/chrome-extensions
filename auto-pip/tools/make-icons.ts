import { join } from 'node:path';
import { sdRoundRect, writeIcons, type Paint } from '../../tools/icon.ts';

const paint: Paint = (x, y) => {
  if (sdRoundRect(x - .5, y - .5, .5, .5, .2) > 0) return null;
  const outer = sdRoundRect(x - .5, y - .47, .32, .24, .035);
  const inner = sdRoundRect(x - .5, y - .47, .27, .19, .015);
  const mini = sdRoundRect(x - .64, y - .61, .16, .115, .025);
  if ((outer <= 0 && inner > 0) || mini <= 0) return [246, 255, 251];
  return [20 - 8 * y, 142 - 32 * y, 120 - 22 * y];
};

writeIcons(join(import.meta.dir, '..', 'icons'), paint);
