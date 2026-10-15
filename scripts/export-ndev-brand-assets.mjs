#!/usr/bin/env node
// Fork add-on: derive the app and web assets from the ndev master, preserving upstream art.
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const sharp = createRequire(new URL("../apps/marketing/package.json", import.meta.url))("sharp");
const assets = path.join(root, "assets/ndev");
const publicAssets = path.join(root, "apps/web/public");
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const navy = "#07172c";
const master = await readFile(path.join(assets, "source/master.png"));
const favicon = await readFile(path.join(assets, "favicon.svg"), "utf8");

// The selected native 1254px master has a precisely finished 1110px tile at (72, 72).
// Cropping its transparent margin lets each platform apply its own safe area once.
const tile = await sharp(master)
  .extract({ left: 72, top: 72, width: 1110, height: 1110 })
  .png()
  .toBuffer();

await mkdir(path.join(assets, "mobile"), { recursive: true });
await mkdir(publicAssets, { recursive: true });

async function save(relative, buffer) {
  await writeFile(path.join(assets, relative), buffer);
  console.log(`Wrote assets/ndev/${relative} (${buffer.length} bytes)`);
}

async function fullIcon(size, bodySize) {
  const body = await sharp(tile).resize(bodySize, bodySize).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: transparent } })
    .composite([{ input: body, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function smallIcon(size) {
  return sharp(Buffer.from(favicon), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const universal = await fullIcon(1024, 960);
const mac = await fullIcon(1024, 824);
await save("app-icon-1024.png", universal);
await save("app-icon-macos-1024.png", mac);
await save("site-icon.webp", await sharp(universal).webp({ lossless: true }).toBuffer());
await save(
  "apple-touch-icon.png",
  await sharp(tile).resize(180, 180).flatten({ background: navy }).png().toBuffer(),
);
await save("icon-192.png", await fullIcon(192, 180));
await save("icon-512.png", await fullIcon(512, 480));

const faviconImages = [];
for (const size of [16, 32, 48]) {
  const contents = await smallIcon(size);
  faviconImages.push({ size, contents });
  await save(`favicon-${size}x${size}.png`, contents);
}
await save("favicon.ico", encodePngIco(faviconImages));

const windowsImages = [];
for (const size of WINDOWS_ICON_SIZES) {
  windowsImages.push({
    size,
    contents: size <= 32 ? await smallIcon(size) : await fullIcon(size, Math.round(size * 0.94)),
  });
}
await save("app-icon.ico", encodePngIco(windowsImages));

// Modern ICNS stores PNG representations, including distinct Retina slots.
const chunks = [];
for (const [type, size] of [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
]) {
  const body = Math.round((size * 824) / 1024);
  const image =
    size <= 32
      ? await sharp({ create: { width: size, height: size, channels: 4, background: transparent } })
          .composite([{ input: await smallIcon(body), gravity: "centre" }])
          .png()
          .toBuffer()
      : await fullIcon(size, body);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(image.length + 8, 4);
  chunks.push(header, image);
}
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
await save("app-icon.icns", Buffer.concat([icnsHeader, ...chunks]));

// Future mobile assets: native masks supply the outer shape, so the adaptive
// foreground uses the simplified ribbon alone within the central safe zone.
const ribbon = favicon.replace(/  <rect[^>]+\/>\n/, "");
const monochrome = ribbon
  .replace(/<defs>[\s\S]*?<\/defs>/, "")
  .replace(/fill="url\(#[^)]+\)"/g, 'fill="white"')
  .replace(/ stroke(?:-opacity|-width)?="[^"]*"/g, "");
await save("mobile/adaptive-foreground.svg", Buffer.from(ribbon));
await save("mobile/monochrome.svg", Buffer.from(monochrome));
await save(
  "mobile/adaptive-foreground.png",
  await sharp(Buffer.from(ribbon), { density: 768 }).resize(1024, 1024).png().toBuffer(),
);
await save(
  "mobile/monochrome.png",
  await sharp(Buffer.from(monochrome), { density: 768 }).resize(1024, 1024).png().toBuffer(),
);
await save(
  "mobile/adaptive-background.png",
  await sharp({ create: { width: 1024, height: 1024, channels: 3, background: navy } })
    .png()
    .toBuffer(),
);
await save(
  "mobile/ios-icon-1024.png",
  await sharp(tile).resize(1024, 1024).flatten({ background: navy }).png().toBuffer(),
);
await save(
  "mobile/splash-mark.png",
  await sharp(Buffer.from(ribbon), { density: 576 }).resize(768, 768).png().toBuffer(),
);
await save(
  "mobile/notification-96.png",
  await sharp(Buffer.from(monochrome), { density: 96 }).resize(96, 96).png().toBuffer(),
);

// Raster social cards are self-contained: no runtime fonts, remote images or page code.
const socialSvg =
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1260" viewBox="0 0 1200 630">
<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#112a47"/><stop offset="1" stop-color="#040b17"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<path d="M530 337H1100" stroke="#789bc2" stroke-opacity=".35"/>
<text x="530" y="300" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="76" letter-spacing="-3" fill="#f5f8ff">ndev.t3code</text>
<text x="533" y="384" font-family="Arial, Helvetica, sans-serif" font-size="27" fill="#b6c6dc">A personal T3 Code fork.</text>
</svg>`);
const social = await sharp(socialSvg)
  .composite([{ input: await sharp(tile).resize(800, 800).png().toBuffer(), left: 150, top: 230 }])
  .png({ compressionLevel: 9 })
  .toBuffer();
await save("og-image@2x.png", social);
await save("og-image.png", await sharp(social).resize(1200, 630).png().toBuffer());

for (const name of [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
]) {
  await copyFile(path.join(assets, name), path.join(publicAssets, name));
  console.log(`Updated apps/web/public/${name}`);
}
