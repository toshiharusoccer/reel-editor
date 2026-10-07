import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

// ---------- state ----------
let clips = []; // { id, file, url, duration, start, end, width, height }
let bgm = null; // { file, url, duration }
let clipSeq = 0;
let ffmpeg = null;
let ffmpegReady = false;

// ---------- dom ----------
const videoInput = document.getElementById("videoInput");
const stepClips = document.getElementById("step-clips");
const stepBgm = document.getElementById("step-bgm");
const stepBuild = document.getElementById("step-build");
const clipListEl = document.getElementById("clipList");
const totalDurationEl = document.getElementById("totalDuration");
const totalWarningEl = document.getElementById("totalWarning");

const bgmInput = document.getElementById("bgmInput");
const bgmInfo = document.getElementById("bgmInfo");
const bgmControls = document.getElementById("bgmControls");
const origVolume = document.getElementById("origVolume");
const origVolumeVal = document.getElementById("origVolumeVal");
const bgmVolume = document.getElementById("bgmVolume");
const bgmVolumeVal = document.getElementById("bgmVolumeVal");
const bgmFade = document.getElementById("bgmFade");
const removeBgmBtn = document.getElementById("removeBgm");

const buildBtn = document.getElementById("buildBtn");
const buildProgress = document.getElementById("buildProgress");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");
const resultBox = document.getElementById("resultBox");
const resultVideo = document.getElementById("resultVideo");
const downloadLink = document.getElementById("downloadLink");
const shareBtn = document.getElementById("shareBtn");

// ---------- helpers ----------
function fmt(sec) {
  return Number.isFinite(sec) ? sec.toFixed(1) : "0.0";
}

// iOS Safari can fail to fire loadedmetadata/seeked on <video> elements that
// are never attached to the document, so probe elements are mounted here
// (off-screen but in-layout) instead of left detached.
const probeHost = document.createElement("div");
probeHost.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;";
document.body.appendChild(probeHost);

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadVideoMeta(file) {
  const task = new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    probeHost.appendChild(v);
    const cleanup = () => v.remove();
    v.onloadedmetadata = () => {
      resolve({ url, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      cleanup();
    };
    v.onerror = () => {
      cleanup();
      reject(new Error("動画の読み込みに失敗しました"));
    };
    v.src = url;
    v.load();
  });
  return withTimeout(task, 15000, "動画の読み込みがタイムアウトしました");
}

function captureThumbnail(url, atTime = 0.1) {
  const task = new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    probeHost.appendChild(v);
    const cleanup = () => v.remove();
    v.addEventListener("loadeddata", () => {
      v.currentTime = Math.min(atTime, (v.duration || 1) - 0.05);
    });
    v.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 96;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(96 / v.videoWidth, 96 / v.videoHeight);
        const w = v.videoWidth * scale;
        const h = v.videoHeight * scale;
        ctx.drawImage(v, (96 - w) / 2, (96 - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve(null);
      } finally {
        cleanup();
      }
    });
    v.addEventListener("error", () => {
      cleanup();
      resolve(null);
    });
    v.src = url;
    v.load();
  });
  return withTimeout(task, 15000, "サムネイル生成がタイムアウトしました").catch(() => null);
}

// ---------- clip management ----------
const addVideoLabel = document.querySelector('label[for="videoInput"]');

async function addFiles(fileList) {
  const originalLabel = addVideoLabel.textContent;
  addVideoLabel.textContent = "読み込み中…";
  addVideoLabel.style.opacity = "0.6";
  for (const file of fileList) {
    try {
      const meta = await loadVideoMeta(file);
      const clip = {
        id: ++clipSeq,
        file,
        url: meta.url,
        duration: meta.duration,
        start: 0,
        end: meta.duration,
        width: meta.width,
        height: meta.height,
        thumb: null,
      };
      clips.push(clip);
      captureThumbnail(meta.url).then((thumb) => {
        clip.thumb = thumb;
        renderClips();
      });
    } catch (e) {
      alert(`${file.name} を読み込めませんでした\n${e.message || ""}`);
    }
  }
  addVideoLabel.textContent = originalLabel;
  addVideoLabel.style.opacity = "";
  renderClips();
  updateSectionVisibility();
}

function renderClips() {
  clipListEl.innerHTML = "";
  clips.forEach((clip, idx) => {
    const el = document.createElement("div");
    el.className = "clip-item";
    el.innerHTML = `
      <div class="clip-item-head">
        <div class="clip-thumb" style="${clip.thumb ? `background-image:url('${clip.thumb}')` : ""}"></div>
        <div class="clip-name">${idx + 1}. ${clip.file.name}</div>
        <div class="clip-order-btns">
          <button class="icon-btn" data-act="up" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="icon-btn" data-act="down" ${idx === clips.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <div class="clip-remove">
          <button class="icon-btn danger" data-act="remove">✕</button>
        </div>
      </div>
      <div class="trim-row">
        <div class="trim-labels">
          <span>開始 ${fmt(clip.start)}s</span>
          <span>使用時間 ${fmt(clip.end - clip.start)}s</span>
          <span>終了 ${fmt(clip.end)}s</span>
        </div>
        <div class="dual-range">
          <input type="range" data-act="start" min="0" max="${clip.duration}" step="0.1" value="${clip.start}">
          <input type="range" data-act="end" min="0" max="${clip.duration}" step="0.1" value="${clip.end}">
        </div>
      </div>
    `;
    el.querySelector('[data-act="up"]').onclick = () => moveClip(idx, -1);
    el.querySelector('[data-act="down"]').onclick = () => moveClip(idx, 1);
    el.querySelector('[data-act="remove"]').onclick = () => removeClip(idx);
    el.querySelector('[data-act="start"]').oninput = (e) => {
      const v = Math.min(parseFloat(e.target.value), clip.end - 0.1);
      clip.start = Math.max(0, v);
      renderClips();
    };
    el.querySelector('[data-act="end"]').oninput = (e) => {
      const v = Math.max(parseFloat(e.target.value), clip.start + 0.1);
      clip.end = Math.min(clip.duration, v);
      renderClips();
    };
    clipListEl.appendChild(el);
  });

  const total = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
  totalDurationEl.textContent = fmt(total);
  totalWarningEl.hidden = total >= 20 && total <= 30;
}

function moveClip(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= clips.length) return;
  [clips[idx], clips[target]] = [clips[target], clips[idx]];
  renderClips();
}

function removeClip(idx) {
  clips.splice(idx, 1);
  renderClips();
  updateSectionVisibility();
}

function updateSectionVisibility() {
  const has = clips.length > 0;
  stepClips.hidden = !has;
  stepBgm.hidden = !has;
  stepBuild.hidden = !has;
}

videoInput.addEventListener("change", (e) => {
  if (e.target.files.length) addFiles(e.target.files);
  e.target.value = "";
});

// ---------- bgm ----------
bgmInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const v = document.createElement("audio");
  v.preload = "metadata";
  v.src = url;
  v.onloadedmetadata = () => {
    bgm = { file, url, duration: v.duration };
    bgmInfo.hidden = false;
    bgmInfo.textContent = `🎵 ${file.name}（${fmt(v.duration)}秒）`;
    bgmControls.hidden = false;
  };
  e.target.value = "";
});

removeBgmBtn.addEventListener("click", () => {
  bgm = null;
  bgmInfo.hidden = true;
  bgmControls.hidden = true;
});

origVolume.addEventListener("input", () => (origVolumeVal.textContent = `${origVolume.value}%`));
bgmVolume.addEventListener("input", () => (bgmVolumeVal.textContent = `${bgmVolume.value}%`));

// ---------- ffmpeg ----------
async function ensureFFmpeg(onLog) {
  if (ffmpegReady) return;
  ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
  const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript");
  const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm");
  await ffmpeg.load({ coreURL, wasmURL });
  ffmpegReady = true;
}

function setProgress(ratio, label) {
  buildProgress.hidden = false;
  progressFill.style.width = `${Math.round(ratio * 100)}%`;
  if (label) progressLabel.textContent = label;
}

async function buildVideo() {
  if (!clips.length) return;
  buildBtn.disabled = true;
  resultBox.hidden = true;
  setProgress(0, "動画処理エンジンを準備中…（初回はダウンロードに時間がかかります）");

  try {
    await ensureFFmpeg();

    const TARGET_W = 1080;
    const TARGET_H = 1920;
    const normalizedNames = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      setProgress((i / (clips.length + 2)), `クリップ ${i + 1}/${clips.length} を処理中…`);
      const inName = `in${i}.mp4`;
      const outName = `norm${i}.mp4`;
      await ffmpeg.writeFile(inName, await fetchFile(clip.file));
      await ffmpeg.exec([
        "-ss", String(clip.start),
        "-to", String(clip.end),
        "-i", inName,
        "-vf", `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
        outName,
      ]);
      normalizedNames.push(outName);
      await ffmpeg.deleteFile(inName);
    }

    setProgress(clips.length / (clips.length + 2), "クリップを結合中…");
    const listContent = normalizedNames.map((n) => `file '${n}'`).join("\n");
    await ffmpeg.writeFile("list.txt", listContent);
    await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "concat.mp4"]);

    let finalName = "concat.mp4";

    if (bgm) {
      setProgress((clips.length + 1) / (clips.length + 2), "BGMを合成中…");
      await ffmpeg.writeFile("bgm_in", await fetchFile(bgm.file));

      const origVol = Number(origVolume.value) / 100;
      const bgmVol = Number(bgmVolume.value) / 100;
      const fade = bgmFade.checked;

      const totalDur = clips.reduce((s, c) => s + (c.end - c.start), 0);
      const fadeOutStart = Math.max(0, totalDur - 1);
      const bgmFilter = fade
        ? `volume=${bgmVol},afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1`
        : `volume=${bgmVol}`;

      const filterComplex = origVol > 0
        ? `[0:a]volume=${origVol}[a0];[1:a]${bgmFilter}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`
        : `[1:a]${bgmFilter}[aout]`;

      await ffmpeg.exec([
        "-i", "concat.mp4",
        "-stream_loop", "-1", "-i", "bgm_in",
        "-filter_complex", filterComplex,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac",
        "-shortest",
        "final.mp4",
      ]);
      finalName = "final.mp4";
    }

    setProgress(1, "書き出し完了！");
    const data = await ffmpeg.readFile(finalName);
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    resultVideo.src = blobUrl;
    downloadLink.href = blobUrl;
    resultBox.hidden = false;

    if (navigator.canShare && navigator.canShare({ files: [new File([blob], "reel.mp4", { type: "video/mp4" })] })) {
      shareBtn.hidden = false;
      shareBtn.onclick = async () => {
        try {
          await navigator.share({
            files: [new File([blob], "reel.mp4", { type: "video/mp4" })],
            title: "リール動画",
          });
        } catch {
          /* user cancelled share sheet */
        }
      };
    } else {
      shareBtn.hidden = true;
    }
  } catch (err) {
    console.error(err);
    alert("動画の作成に失敗しました。もう一度お試しください。\n" + err.message);
  } finally {
    buildBtn.disabled = false;
  }
}

buildBtn.addEventListener("click", buildVideo);

// ---------- pwa ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
