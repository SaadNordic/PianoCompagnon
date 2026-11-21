// Génère les icônes et écrans de démarrage Android à partir de public/icon.svg
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const res = 'android/app/src/main/res';
const svg = fs.readFileSync('public/icon.svg', 'utf8');
const inner = svg.replace(/<rect width="512" height="512"[^>]*\/>/, ''); // sans le fond
const fgSvg = inner.replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-150 -150 812 812">');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(res, 'mipmap-' + d);
    const s = Math.round(48 * k);
    await sharp(Buffer.from(svg), { density: 400 }).resize(s, s).png().toFile(path.join(dir, 'ic_launcher.png'));
    const mask = Buffer.from(`<svg width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></svg>`);
    await sharp(Buffer.from(svg), { density: 400 }).resize(s, s).composite([{ input: mask, blend: 'dest-in' }]).png().toFile(path.join(dir, 'ic_launcher_round.png'));
    const f = Math.round(108 * k);
    await sharp(Buffer.from(fgSvg), { density: 400 }).resize(f, f).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
  }
  const splashes = fs.readdirSync(res).filter(d => d.startsWith('drawable')).map(d => path.join(res, d, 'splash.png')).filter(f => fs.existsSync(f));
  for (const f of splashes) {
    const { width, height } = await sharp(f).metadata();
    const logo = Math.round(Math.min(width, height) * 0.32);
    const icon = await sharp(Buffer.from(svg), { density: 400 }).resize(logo, logo).png().toBuffer();
    await sharp({ create: { width, height, channels: 4, background: '#14161c' } })
      .composite([{ input: icon, gravity: 'center' }]).png().toFile(f + '.tmp');
    fs.renameSync(f + '.tmp', f);
  }
  console.log('icônes et', splashes.length, 'écrans de démarrage générés');
})();
