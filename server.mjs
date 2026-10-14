import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const PORT = clampInt(process.env.PORT, 1, 65535, 8788);
const RESOLVER_TOKEN = String(process.env.RESOLVER_TOKEN || '');
const MAX_CONCURRENT = clampInt(process.env.MAX_CONCURRENT, 1, 10, 2);
const DEFAULT_MAX_BYTES = clampInt(process.env.MAX_IMPORT_MB, 1, 100, 50) * 1024 * 1024;
const DEFAULT_MAX_DURATION = clampInt(process.env.MAX_DURATION_SECONDS, 30, 3600, 600);
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const SPOTIFY_OEMBED_ENDPOINT = process.env.SPOTIFY_OEMBED_ENDPOINT || 'https://open.spotify.com/oembed';
let active = 0;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}
function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':data.length,'cache-control':'no-store'});
  res.end(data);
}
function cleanText(v, max=180) { return String(v ?? '').replace(/[\r\n\x00-\x1f\x7f]/g,' ').trim().slice(0,max); }
function safeName(v) {
  const s = cleanText(v || 'audio', 140).replace(/[<>:"/\\|?*]/g,'_').replace(/\s+/g,' ').replace(/[. ]+$/,'').trim();
  return s || 'audio';
}
function asciiHeaderName(v){return safeName(v).replace(/[^\x20-\x7e]/g,'_').slice(0,120)||'audio'}
function providerFor(u) {
  const h = u.hostname.toLowerCase().replace(/^www\./,'');
  if (h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'open.spotify.com' || h.endsWith('.spotify.com')) return 'spotify';
  if (h === 'soundcloud.com' || h.endsWith('.soundcloud.com')) return 'soundcloud';
  return 'direct';
}
function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (ip === '::1' || ip === '0.0.0.0') return true;
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const x = ip.toLowerCase();
  return x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw coded('URL tidak valid','INVALID_URL',400); }
  if (!['http:','https:'].includes(u.protocol)) throw coded('URL harus http/https','INVALID_URL',400);
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw coded('Host URL tidak diizinkan','URL_HOST_BLOCKED',400);
  if (net.isIP(host) && isPrivateIp(host)) throw coded('Private IP tidak diizinkan','URL_HOST_BLOCKED',400);
  if (providerFor(u) !== 'direct') return u;
  try {
    const rows = await lookup(host,{all:true,verbatim:true});
    if (rows.some(x=>isPrivateIp(x.address))) throw coded('Private network tidak diizinkan','URL_HOST_BLOCKED',400);
  } catch (e) {
    if (e?.code && String(e.code).startsWith('URL_')) throw e;
    if (e?.status) throw e;
    throw coded('Hostname tidak dapat di-resolve','URL_DNS_FAILED',400);
  }
  return u;
}
function coded(message, code='RESOLVE_FAILED', status=400) { const e = new Error(message); e.code=code; e.status=status; return e; }
function run(bin,args,{timeoutMs=120000,cwd}={}) {
  return new Promise((resolve,reject)=>{
    const cp=spawn(bin,args,{cwd,stdio:['ignore','pipe','pipe']});
    const out=[],err=[]; let done=false;
    const timer=setTimeout(()=>{if(done)return;done=true;cp.kill('SIGKILL');reject(coded('Proses media timeout','MEDIA_TIMEOUT',504))},timeoutMs);
    cp.stdout.on('data',d=>{if(Buffer.concat(out).length<4*1024*1024)out.push(d)});
    cp.stderr.on('data',d=>{if(Buffer.concat(err).length<2*1024*1024)err.push(d)});
    cp.on('error',e=>{if(done)return;done=true;clearTimeout(timer);reject(coded(`Executable ${bin} tidak tersedia: ${e.message}`,'RESOLVER_DEPENDENCY_MISSING',500))});
    cp.on('close',code=>{if(done)return;done=true;clearTimeout(timer);const stdout=Buffer.concat(out).toString('utf8'),stderr=Buffer.concat(err).toString('utf8');if(code===0)resolve({stdout,stderr});else reject(coded(cleanText(stderr.split('\n').filter(Boolean).slice(-3).join(' · ')||`${bin} exit ${code}`,500),'MEDIA_EXTRACT_FAILED',422))});
  });
}
async function ytdlpMetadata(target) {
  const {stdout}=await run(YTDLP_BIN,['--no-playlist','--no-warnings','--quiet','--dump-single-json','--skip-download',target],{timeoutMs:60000});
  let data; try{data=JSON.parse(stdout)}catch{throw coded('Metadata source tidak dapat dibaca','METADATA_FAILED',422)}
  return data || {};
}
async function ytdlpToMp3(target,dir) {
  const out=join(dir,'source.%(ext)s');
  await run(YTDLP_BIN,['--no-playlist','--no-warnings','--quiet','--retries','2','--socket-timeout','20','-x','--audio-format','mp3','--audio-quality','0','--postprocessor-args','ffmpeg:-ar 44100','-o',out,target],{timeoutMs:180000});
  const files=(await readdir(dir)).filter(x=>x.toLowerCase().endsWith('.mp3'));
  if(!files.length)throw coded('MP3 hasil resolver tidak ditemukan','OUTPUT_MISSING',500);
  return join(dir,files[0]);
}
async function spotifyTrackTarget(sourceUrl) {
  const u=new URL(sourceUrl);
  if(!/^\/track\/[A-Za-z0-9]+/.test(u.pathname))throw coded('Saat ini Spotify URL import mendukung link track tunggal, bukan album/playlist.','SPOTIFY_TRACK_ONLY',422);
  const endpoint=`${SPOTIFY_OEMBED_ENDPOINT}?url=${encodeURIComponent(sourceUrl)}`;
  const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),15000);
  let r; try{r=await fetch(endpoint,{headers:{'user-agent':'GhostStudioMediaResolver/1.0'},signal:ctl.signal})}catch{throw coded('Metadata Spotify gagal diambil','SPOTIFY_METADATA_FAILED',502)}finally{clearTimeout(timer)}
  if(!r.ok)throw coded(`Metadata Spotify HTTP ${r.status}`,'SPOTIFY_METADATA_FAILED',422);
  const d=await r.json(); const title=cleanText(d.title,180),artist=cleanText(d.author_name,120); if(!title)throw coded('Judul track Spotify tidak ditemukan','SPOTIFY_METADATA_FAILED',422);
  return {target:`ytsearch1:${[title,artist,'audio'].filter(Boolean).join(' ')}`,title:artist?`${title} — ${artist}`:title};
}
async function downloadPublic(url,dir,maxBytes) {
  let current=await assertPublicUrl(url);
  for(let hop=0;hop<5;hop++){
    const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),30000);
    let r; try{r=await fetch(current,{redirect:'manual',headers:{'user-agent':'GhostStudioMediaResolver/1.0','accept':'audio/*,application/octet-stream;q=0.9,*/*;q=0.1'},signal:ctl.signal})}finally{clearTimeout(timer)}
    if([301,302,303,307,308].includes(r.status)){
      const loc=r.headers.get('location'); if(!loc)throw coded('Redirect tanpa Location','DIRECT_REDIRECT_FAILED',422);
      current=await assertPublicUrl(new URL(loc,current).toString()); continue;
    }
    if(!r.ok)throw coded(`Direct audio HTTP ${r.status}`,'DIRECT_FETCH_FAILED',422);
    const type=(r.headers.get('content-type')||'').split(';')[0].toLowerCase();
    const ext=extname(current.pathname).toLowerCase(); const known=['.mp3','.wav','.ogg','.flac','.aac','.m4a','.webm','.opus'];
    if(!type.startsWith('audio/')&&!known.includes(ext))throw coded('URL direct tidak terlihat sebagai file audio','DIRECT_NOT_AUDIO',415);
    const declared=Number(r.headers.get('content-length')||0); if(declared&&declared>maxBytes)throw coded('Audio source terlalu besar','MEDIA_TOO_LARGE',413);
    const chunks=[]; let size=0; const reader=r.body.getReader();
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){try{reader.cancel()}catch{}throw coded('Audio source terlalu besar','MEDIA_TOO_LARGE',413)}chunks.push(Buffer.from(value))}
    const input=join(dir,'direct'+(known.includes(ext)?ext:'.bin'));await writeFile(input,Buffer.concat(chunks));return {input,type};
  }
  throw coded('Terlalu banyak redirect','TOO_MANY_REDIRECTS',422);
}
async function probeDuration(file) {
  try{const {stdout}=await run(FFPROBE_BIN,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{timeoutMs:20000});const n=Number(stdout.trim());return Number.isFinite(n)?n:null}catch{return null}
}
async function convertToMp3(input,dir) {
  const out=join(dir,'source.mp3');
  await run(FFMPEG_BIN,['-hide_banner','-loglevel','error','-y','-i',input,'-vn','-ar','44100','-codec:a','libmp3lame','-b:a','192k',out],{timeoutMs:120000});
  return out;
}
async function resolveOne(sourceUrl,maxBytes,maxDuration) {
  const u=await assertPublicUrl(sourceUrl); const provider=providerFor(u); const dir=await mkdtemp(join(tmpdir(),'ghost-media-'));
  try{
    let file,title='Imported audio',duration=null;
    if(provider==='youtube'||provider==='soundcloud'){
      const meta=await ytdlpMetadata(sourceUrl);duration=Number(meta.duration)||null;title=cleanText(meta.title||meta.fulltitle||'Imported audio',180);if(duration&&duration>maxDuration)throw coded(`Durasi source ${Math.round(duration)}s melebihi batas import ${maxDuration}s`,'MEDIA_TOO_LONG',422);file=await ytdlpToMp3(sourceUrl,dir);
    }else if(provider==='spotify'){
      const sp=await spotifyTrackTarget(sourceUrl);title=sp.title;const meta=await ytdlpMetadata(sp.target);duration=Number(meta.duration)||null;if(duration&&duration>maxDuration)throw coded(`Durasi source ${Math.round(duration)}s melebihi batas import ${maxDuration}s`,'MEDIA_TOO_LONG',422);file=await ytdlpToMp3(sp.target,dir);
    }else{
      const d=await downloadPublic(sourceUrl,dir,maxBytes);duration=await probeDuration(d.input);if(duration&&duration>maxDuration)throw coded(`Durasi source ${Math.round(duration)}s melebihi batas import ${maxDuration}s`,'MEDIA_TOO_LONG',422);file=await convertToMp3(d.input,dir);title=safeName(u.pathname.split('/').pop()?.replace(/\.[^.]+$/,'')||u.hostname);
    }
    const st=await stat(file); if(st.size<=0)throw coded('Audio hasil kosong','OUTPUT_EMPTY',500);if(st.size>maxBytes)throw coded('Audio hasil import terlalu besar','MEDIA_TOO_LARGE',413);
    const bytes=await readFile(file); return {bytes,provider,title:safeName(title),duration};
  }finally{await rm(dir,{recursive:true,force:true}).catch(()=>{})}
}
async function readBody(req,max=32*1024){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>max)throw coded('Request terlalu besar','REQUEST_TOO_LARGE',413);chunks.push(c)}return Buffer.concat(chunks).toString('utf8')}
function authorized(req){if(!RESOLVER_TOKEN)return true;const h=String(req.headers.authorization||'');return h===`Bearer ${RESOLVER_TOKEN}`}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,service:'Ghost Media Resolver',active,maxConcurrent:MAX_CONCURRENT});
    if(req.method!=='POST'||req.url!=='/v1/resolve')return json(res,404,{ok:false,error:'NOT_FOUND'});
    if(!authorized(req))return json(res,401,{ok:false,error:'UNAUTHORIZED',message:'Resolver token tidak valid'});
    if(active>=MAX_CONCURRENT)return json(res,429,{ok:false,error:'BUSY',message:'Resolver sedang penuh. Coba lagi sebentar.'});
    let body;try{body=JSON.parse(await readBody(req))}catch{return json(res,400,{ok:false,error:'BAD_JSON',message:'Body JSON tidak valid'})}
    const sourceUrl=String(body.url||'').trim();if(!sourceUrl)return json(res,400,{ok:false,error:'URL_REQUIRED',message:'URL wajib diisi'});
    const maxBytes=Math.min(clampInt(body.maxBytes,1024*1024,100*1024*1024,DEFAULT_MAX_BYTES),DEFAULT_MAX_BYTES);
    const maxDuration=Math.min(clampInt(body.maxDurationSeconds,30,3600,DEFAULT_MAX_DURATION),DEFAULT_MAX_DURATION);
    active++;
    try{
      const out=await resolveOne(sourceUrl,maxBytes,maxDuration);const filename=asciiHeaderName(out.title)+'.mp3';
      res.writeHead(200,{'content-type':'audio/mpeg','content-length':out.bytes.length,'content-disposition':`attachment; filename="${filename}"`,'cache-control':'no-store','x-source-provider':out.provider,'x-source-title':encodeURIComponent(out.title),'x-source-duration':out.duration?String(out.duration):''});res.end(out.bytes);
    }finally{active--}
  }catch(e){if(active<0)active=0;json(res,e?.status||500,{ok:false,error:e?.code||'SERVER_ERROR',message:cleanText(e?.message||String(e),500)})}
});
server.listen(PORT,'0.0.0.0',()=>process.stdout.write(`Ghost Media Resolver listening on :${PORT}\n`));
