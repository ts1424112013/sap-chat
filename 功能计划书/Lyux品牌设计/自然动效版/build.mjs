import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const ids = ['echo','spirit','crescent'];
const context = {window:{}};
vm.createContext(context);
for (const id of ids) vm.runInContext(readFileSync(join(dir,'concepts',id+'.js'),'utf8'),context);
mkdirSync(join(dir,'exports'),{recursive:true});
for (const concept of context.window.LyuxConcepts) {
  for (const state of ['idle','thinking','running']) {
    const svg = concept.svg.replace('<svg ','<svg width="120" height="120" ').replace('data-state="idle"','data-state="'+state+'"');
    writeFileSync(join(dir,'exports',concept.id+'-'+state+'.svg'),svg);
  }
  const still = concept.svg.replace('<svg ','<svg width="120" height="120" ').replace('data-state="idle"','data-state="static"');
  writeFileSync(join(dir,'exports',concept.id+'-static.svg'),still);
}
let html=readFileSync(join(dir,'index.html'),'utf8');
html=html.replace('<link rel="stylesheet" href="preview.css">','<style>'+readFileSync(join(dir,'preview.css'),'utf8')+'</style>');
html=html.replace(/<script src="([^"]+)"><\/script>/g,(_,src)=>'<script>'+readFileSync(join(dir,src),'utf8')+'</script>');
writeFileSync(join(dir,'自然动效预览.html'),html);
console.log('Built standalone preview and 12 SVG files.');
