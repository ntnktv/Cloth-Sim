export const isVideo=source=>source?.tagName==='VIDEO';
export const videos=flags=>[...new Set(flags.map(f=>f.image).filter(isVideo))];
export function disposeVideo(video){video.pause();video.removeAttribute('src');video.load();if(video.objectURL)URL.revokeObjectURL(video.objectURL);}
function waitMedia(video,event,action){return new Promise((resolve,reject)=>{const done=error=>{clearTimeout(timer);video.removeEventListener(event,ok);video.removeEventListener('error',fail);error?reject(error):resolve();},ok=()=>done(),fail=()=>done(new Error('Не удалось декодировать MP4. Попробуйте MP4 с кодеком H.264.')),timer=setTimeout(()=>done(new Error('Видео не успело загрузиться или перемотаться. Попробуйте меньший MP4.')),15000);video.addEventListener(event,ok,{once:true});video.addEventListener('error',fail,{once:true});try{action();}catch(e){done(e);}});}
export async function loadVideo(file){
 if(file.size>250*1024*1024)throw new Error('MP4 больше 250 МБ.');
 const v=document.createElement('video');v.muted=true;v.defaultMuted=true;v.loop=true;v.playsInline=true;v.preload='auto';v.sourceBlob=file;v.objectURL=URL.createObjectURL(file);
 try{await waitMedia(v,'loadeddata',()=>{v.src=v.objectURL;v.load();});if(!v.videoWidth||!v.videoHeight||!Number.isFinite(v.duration)||v.duration<=0)throw new Error('Не удалось прочитать размеры или длительность MP4.');if(Math.max(v.videoWidth/v.videoHeight,v.videoHeight/v.videoWidth)>15)throw new Error('Пропорции видео должны быть не шире 15:1.');v.width=v.videoWidth;v.height=v.videoHeight;return v;}catch(e){disposeVideo(v);throw e;}
}
export async function seekVideo(v,time){const target=((time%v.duration)+v.duration)%v.duration;if(!v.seeking&&Math.abs(v.currentTime-target)<1e-6&&v.readyState>=2)return;await waitMedia(v,'seeked',()=>{v.currentTime=target;});}
export function syncVideos(flags,playing,speed,onError=()=>{}){for(const v of videos(flags)){v.playbackRate=speed;const shouldPlay=playing&&flags.some(f=>f.image===v&&f.visible&&f.animationEnabled!==false);if(!shouldPlay){v.pause();continue;}if(v.paused&&!v.playPending&&!v.playFailed){v.playPending=true;v.play().catch(e=>{if(e.name!=='AbortError'){v.playFailed=true;onError('Не удалось запустить MP4. Нажмите паузу и продолжите воспроизведение.');}}).finally(()=>v.playPending=false);}}}
export async function seekVideos(flags,time){await Promise.all(videos(flags).map(v=>seekVideo(v,time)));}

export async function cloneVideo(source){const copy=await loadVideo(source.sourceBlob);try{await seekVideo(copy,source.currentTime);return copy;}catch(e){disposeVideo(copy);throw e;}}
