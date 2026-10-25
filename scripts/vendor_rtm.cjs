'use strict';
// Reproduce the pinned RTM browser asset from pnpm's integrity-locked package. No network at runtime.
const fs=require('node:fs'),path=require('node:path');
const packagePath=require.resolve('agora-rtm-sdk/package.json');
const pkg=JSON.parse(fs.readFileSync(packagePath));
if(pkg.version!=='1.5.1')throw new Error('unexpected_rtm_version');
const source=path.join(path.dirname(packagePath),'index.js');
const target=path.join(__dirname,'../static/vendor/rtm@1.5.1.min.js');
fs.copyFileSync(source,target);
console.log('Pinned RTM 1.5.1 asset written; runtime log upload remains disabled.');
