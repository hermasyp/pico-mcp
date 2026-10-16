/*
 * Hand-made headers: the smallest bytes each picture format needs to say how big the picture is. Not decodable
 * pictures, which is all the connector needs (it reads the size, and Pico does the decoding).
 */

export const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
export const le16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255])
export const le24 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255])
export const le32 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255])

export const png = (width: number, height: number) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from('IHDR'), be32(width), be32(height), Buffer.from([8, 2, 0, 0, 0]), be32(0), be32(0), Buffer.from('IEND'), be32(0)])
export const gif = (width: number, height: number) => Buffer.concat([Buffer.from('GIF89a'), le16(width), le16(height), Buffer.from([0, 0, 0, 0x3b])])
export const jpeg = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0'),
    Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 8]),
    Buffer.from([(height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255]),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xd9]),
  ])
export const riff = (chunk: Buffer) => Buffer.concat([Buffer.from('RIFF'), le32(chunk.length + 4), Buffer.from('WEBP'), chunk])
export const webpLossy = (width: number, height: number) => riff(Buffer.concat([Buffer.from('VP8 '), le32(10), Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a]), le16(width), le16(height)]))
export const webpLossless = (width: number, height: number) => {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  return riff(Buffer.concat([Buffer.from('VP8L'), le32(5), Buffer.from([0x2f]), le32(bits >>> 0)]))
}
export const webpExtended = (width: number, height: number) => riff(Buffer.concat([Buffer.from('VP8X'), le32(10), Buffer.from([0, 0, 0, 0]), le24(width - 1), le24(height - 1)]))
