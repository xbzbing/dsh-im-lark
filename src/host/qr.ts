/**
 * 最小 QR 码编码器（byte 模式、纠错等级 L、固定 mask 0）。
 *
 * 只为一件事服务：把「一键创建应用」拿到的授权链接渲染成二维码。链接是 ASCII
 * URL，长度几十到几百字节，所以不需要数字/字母数字模式，也不需要挑最优 mask；
 * 固定 mask 0 仍然是合法二维码，扫码器按格式信息里的 mask 位解码即可。
 *
 * 不引依赖：面板要展示二维码，但为一个固定用途引入编码库不划算，而且编码器
 * 只输出模块矩阵，渲染交给浏览器（SVG），不在 host 端生成图片。
 *
 * 算法按 ISO/IEC 18004 实现：byte 模式分段 → 版本自适应 → Reed-Solomon 纠错 →
 * 交织 → 功能图形 → 之字形填数据 → mask 0 → 格式信息。单测里用 npm 的
 * `qrcode` 包逐模块比对矩阵，并用 jsQR 实际解码，避免「看起来像二维码」。
 */

/** 二维码模块矩阵：行优先，1 深色、0 浅色。 */
export interface QrMatrix {
  /** 边长（模块数），等于 `17 + 4 * version`。 */
  size: number;
  /** 长度 `size * size` 的模块数组。 */
  modules: number[];
}

/** 纠错等级 L 下每个纠错块的字节数（下标是版本号，0 占位）。 */
const ECC_CODEWORDS_PER_BLOCK_L = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];

/** 纠错等级 L 下的纠错块数量（下标是版本号，0 占位）。 */
const NUM_BLOCKS_L = [
  0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17,
  18, 19, 19, 20, 21, 22, 24, 25,
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** 纠错等级 L 在格式信息里的两位编码。 */
const ECC_L_BITS = 1;

/** 固定使用的 mask。 */
const MASK = 0;

/** 生成二维码矩阵；内容超过版本 40 的容量时抛错。 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;

  const codewords = buildCodewords(bytes, version);
  const modules = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const setFunction = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y * size + x] = dark ? 1 : 0;
    isFunction[y * size + x] = 1;
  };

  drawFunctionPatterns(version, size, setFunction);
  drawCodewords(codewords, size, modules, isFunction);

  // mask 只作用于数据模块；功能图形（含格式信息）保持不变。
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isFunction[y * size + x] === 0 && (x + y) % 2 === 0) {
        modules[y * size + x] ^= 1;
      }
    }
  }
  drawFormatBits(size, MASK, setFunction);

  return { size, modules: Array.from(modules) };
}

/** 选能装下内容的最小版本；byte 模式在 v1–9 用 8 位长度、v10+ 用 16 位。 */
function pickVersion(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    const capacity = numDataCodewords(version) * 8;
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= capacity) return version;
  }
  throw new Error('内容过长，无法生成二维码');
}

/** 版本信息 + 数据 + 填充，按块拆开并交织成最终码字序列。 */
function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const capacity = numDataCodewords(version);
  const bits: number[] = [];

  const append = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  // byte 模式指示符 0100 + 字符计数 + 数据。
  append(0b0100, 4);
  append(bytes.length, charCountBits(version));
  for (const byte of bytes) append(byte, 8);

  // 终止符最多 4 位，然后补零到字节边界。
  const capacityBits = capacity * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);

  // 交替填充 0xEC / 0x11，直到数据码字满。
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j]!;
    data.push(value);
  }

  const numBlocks = NUM_BLOCKS_L[version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK_L[version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const shortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLength);

  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let block = 0; block < numBlocks; block += 1) {
    const dataLength = shortBlockLength - eccLength + (block < shortBlocks ? 0 : 1);
    const chunk = data.slice(offset, offset + dataLength);
    offset += dataLength;
    dataBlocks.push(chunk);
    eccBlocks.push(rsRemainder(chunk, divisor));
  }

  // 交织：先按列取各块的数据码字，再按列取纠错码字。
  const result: number[] = [];
  const maxDataLength = shortBlockLength - eccLength + 1;
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < eccLength; i += 1) {
    for (const block of eccBlocks) result.push(block[i]!);
  }
  return result;
}

/** 数据码字数量：总码字减去纠错码字。 */
function numDataCodewords(version: number): number {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK_L[version]! * NUM_BLOCKS_L[version]!;
}

/** 版本可容纳的原始数据模块数（扣除功能图形与格式/版本信息）。 */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** 画三个定位图形、时序图形、校正图形、版本信息，并预留格式信息位置。 */
function drawFunctionPatterns(
  version: number,
  size: number,
  setFunction: (x: number, y: number, dark: boolean) => void,
): void {
  // 时序图形先画，定位图形与校正图形会覆盖交叉处，符合标准。
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      // 三个角上的校正图形与定位图形重叠，跳过。
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = positions[i]!;
      const cy = positions[j]!;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // 先占位格式信息（mask 0 的最终值后面会重画一遍），让数据填充跳过这些模块。
  drawFormatBits(size, MASK, setFunction);

  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }
}

/** 校正图形中心坐标；版本 1 没有校正图形。 */
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const result = [6];
  let position = size - 7;
  for (let i = 0; i < count - 1; i += 1) {
    result.splice(1, 0, position);
    position -= step;
  }
  return result;
}

/** 从右下角起按两列一组之字形填数据，跳过功能图形。 */
function drawCodewords(codewords: number[], size: number, modules: Uint8Array, isFunction: Uint8Array): void {
  let index = 0;
  const totalBits = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    // 第 6 列是竖直时序图形，跳过它，两列一组整体左移。
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        const at = y * size + x;
        if (isFunction[at] === 0 && index < totalBits) {
          modules[at] = (codewords[index >>> 3]! >>> (7 - (index & 7))) & 1;
          index += 1;
        }
      }
    }
  }
}

/** 画格式信息（ECC L + mask），并放上固定深色模块。 */
function drawFormatBits(
  size: number,
  mask: number,
  setFunction: (x: number, y: number, dark: boolean) => void,
): void {
  let data = (ECC_L_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  const bit = (index: number): boolean => ((bits >>> index) & 1) !== 0;

  // 第一份：左上角。
  for (let i = 0; i <= 5; i += 1) setFunction(8, i, bit(i));
  setFunction(8, 7, bit(6));
  setFunction(8, 8, bit(7));
  setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bit(i));

  // 第二份：右上与左下。
  for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, bit(i));

  // 固定深色模块（标准要求恒为深色）。
  setFunction(8, size - 8, true);
}

/** Reed-Solomon 生成多项式。 */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Reed-Solomon 余式：一组数据码字的纠错码字。 */
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) result[i]! ^= gfMultiply(divisor[i]!, factor);
  }
  return result;
}

/** GF(256) 乘法，本原多项式 0x11D。 */
function gfMultiply(x: number, y: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((y >>> i) & 1) * x;
  }
  return result & 0xff;
}
