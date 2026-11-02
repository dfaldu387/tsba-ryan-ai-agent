import { readFileSync, writeFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
const buf = readFileSync('C:/Users/Admin/Downloads/DEYE SUN-8K-SG05LP1-AU _ Installation Guide.pdf');
const { text, numpages } = await pdfParse(buf);
console.log('pages:', numpages, 'chars:', text.length);
writeFileSync('./scratch-guide.txt', text);
// Find sections mentioning monitoring / solarman / wifi / app
const low = text.toLowerCase();
for (const kw of ['solarman','monitoring','wi-fi','wifi','logger','app','portal','pro.solarman','home.solarman','plug']) {
  const idx = low.indexOf(kw);
  console.log(kw.padEnd(14), idx>=0 ? 'found @'+idx : 'NOT FOUND', low.split(kw).length-1+' hits');
}
