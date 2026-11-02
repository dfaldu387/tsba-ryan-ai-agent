import { readFileSync } from 'node:fs';
const t = readFileSync('./scratch-guide.txt','utf8');
const show = (a,b,label)=>{console.log('\n===== '+label+' ['+a+'-'+b+'] =====\n'+t.slice(a,b));};
show(3200,7200,'WIFI / MONITORING / PLUG');
show(16800,19800,'SOLARMAN / PORTAL');
