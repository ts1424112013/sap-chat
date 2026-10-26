/* 从正式控件的单一图形源生成静态图标，避免发布时轮廓或颜色不一致。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let artwork;
vm.runInNewContext(fs.readFileSync(path.join(root, 'webapp/control/LingXiArtwork.js'), 'utf8'), {
  sap: { ui: { define: (_, factory) => { artwork = factory(); } } }
});
fs.writeFileSync(path.join(root, 'webapp/images/lingxi-mark.svg'), artwork.svg('lingxi-mark') + '\n');
const inner = artwork.svg('lingxi-favicon').replace('width="260" height="268"', 'x="3" y="2" width="58" height="60"');
fs.writeFileSync(path.join(root, 'webapp/images/lingxi-favicon.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>灵犀 LingXi</title><rect width="64" height="64" rx="15" fill="#24424D"/>' + inner + '</svg>\n');
console.log('LingXi static logo and favicon generated.');
