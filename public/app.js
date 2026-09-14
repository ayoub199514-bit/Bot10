const $ = (s) => document.querySelector(s);

const dropZone = $("#dropZone");
const wellIdle = $("#wellIdle");
const input = $("#imageInput");
const choose = $("#chooseBtn");
const clearBtn = $("#clearBtn");
const preview = $("#preview");
const previewWrap = $("#previewWrap");
const analyze = $("#analyzeBtn");
const newBtn = $("#newBtn");
const urlInput = $("#imageUrl");
const fetchUrlBtn = $("#fetchUrlBtn");
const connDot = $("#connDot");
const connLabel = $("#connLabel");
const clock = $("#clock");

let imageDataUrl = "";
let timerId = null;

/* ---------- clock ---------- */
function tickClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString("ar-EG", { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- image intake ---------- */
function setImage(dataUrl) {
  imageDataUrl = dataUrl;
  preview.src = dataUrl;
  wellIdle.style.display = "none";
  previewWrap.classList.add("show");
  analyze.disabled = false;
}

function compressImage(dataUrl, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    connLabel.textContent = "اختر ملف صورة صالح";
    return;
  }
  connLabel.textContent = "جارٍ تجهيز الصورة...";
  const rawDataUrl = await fileToDataUrl(file);
  const compressed = await compressImage(rawDataUrl);
  setImage(compressed);
  connLabel.textContent = "جاهز للتحليل";
  const sysLine = document.getElementById("sysLine");
  if (sysLine) sysLine.innerHTML = 'SYS &gt; image_loaded<span class="cursor">▌</span>';
}

choose.addEventListener("click", () => input.click());
input.addEventListener("change", () => handleFile(input.files?.[0]));

/* drag & drop */
["dragover", "dragenter"].forEach(evt =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
);
["dragleave", "drop"].forEach(evt =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
);
dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

/* clipboard paste — the primary interaction */
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) handleFile(file);
      return;
    }
  }
});

/* paste a direct image link — fetched server-side to sidestep CORS */
fetchUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  fetchUrlBtn.disabled = true;
  fetchUrlBtn.textContent = "...";
  try {
    const res = await fetch("/api/fetch-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "تعذر جلب الصورة من الرابط.");
    const compressed = await compressImage(data.imageDataUrl);
    setImage(compressed);
    urlInput.value = "";
  } catch (e) {
    alert(e.message);
  } finally {
    fetchUrlBtn.disabled = false;
    fetchUrlBtn.textContent = "جلب";
  }
});

clearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  resetImage();
});

function resetImage() {
  imageDataUrl = "";
  input.value = "";
  preview.src = "";
  previewWrap.classList.remove("show");
  wellIdle.style.display = "";
  analyze.disabled = true;
}

/* ---------- analysis ---------- */
async function analyzeChart() {
  if (!imageDataUrl) return;
  analyze.disabled = true;
  analyze.querySelector(".fab-label").textContent = "جاري التحليل...";
  analyze.classList.add("busy");
  connLabel.textContent = "يقرأ الشموع...";
  $("#dropZone").classList.add("scanning");
  const sysLine = $("#sysLine");
  sysLine.innerHTML = 'SYS &gt; scanning_candles<span class="cursor">▌</span>';

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        assetHint: $("#assetHint").value.trim(),
        timeframeHint: $("#timeframeHint").value
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "فشل التحليل");
    renderSignal(data);
    connLabel.textContent = "جاهز للتحليل";
    sysLine.innerHTML = 'SYS &gt; analysis_complete<span class="cursor">▌</span>';
  } catch (e) {
    alert(e.message);
    connLabel.textContent = "فشل آخر تحليل";
    sysLine.innerHTML = 'SYS &gt; error_state<span class="cursor">▌</span>';
  } finally {
    analyze.disabled = false;
    analyze.querySelector(".fab-label").textContent = "تحليل الشارت الآن";
    analyze.classList.remove("busy");
    $("#dropZone").classList.remove("scanning");
  }
}

function renderSignal(data) {
  const box = $("#verdictBox");
  box.className = "verdict " + data.direction.toLowerCase();

  const icons = { CALL: "↗", PUT: "↘", WAIT: "···" };
  $("#verdictIcon").textContent = icons[data.direction] || "···";
  $("#directionText").textContent = data.direction === "CALL" ? "CALL" : data.direction === "PUT" ? "PUT" : "WAIT";
  $("#confidenceText").textContent = `ثقة تحليلية ${data.confidence}%`;
  $("#assetText").textContent = `${data.asset || $("#assetHint").value || "الأصل غير معروف"}${data.timeframe ? " · " + data.timeframe : ""}`;

  const ringWrap = $("#confRingWrap");
  const ringFg = $("#confRingFg");
  const ringValue = $("#confRingValue");
  const circumference = 213.6;
  const pct = Math.max(0, Math.min(100, Number(data.confidence) || 0));
  ringWrap.hidden = false;
  ringValue.textContent = pct + "%";
  requestAnimationFrame(() => {
    ringFg.style.strokeDashoffset = circumference - (circumference * pct) / 100;
  });

  const reasons = $("#reasons");
  reasons.innerHTML = "";
  (data.reasons || []).forEach(r => {
    const li = document.createElement("li");
    li.textContent = r;
    reasons.appendChild(li);
  });
  if (!reasons.children.length) reasons.innerHTML = "<li>لا توجد أسباب كافية.</li>";

  const indicators = $("#indicators");
  indicators.innerHTML = "";
  (data.indicators || []).forEach(i => {
    const span = document.createElement("span");
    span.textContent = i;
    indicators.appendChild(span);
  });

  $("#warning").textContent = data.warning || "التحليل لا يضمن نتيجة الصفقة.";

  const mtfRow = $("#mtfRow");
  if (data.multi_signals) {
    mtfRow.hidden = false;
    const dirLabel = { CALL: "صعود", PUT: "هبوط", WAIT: "ترقب" };
    ["short", "medium", "long"].forEach(key => {
      const card = mtfRow.querySelector(`[data-tf="${key}"]`);
      const sig = data.multi_signals[key] || { direction: "WAIT", confidence: 0 };
      card.className = "mtf-card " + sig.direction.toLowerCase();
      card.querySelector('[data-role="dir"]').textContent = `${dirLabel[sig.direction] || "ترقب"} · ${sig.confidence}%`;
    });
  }

  startTimer(Number(data.expiry_seconds) || 0);
}

function startTimer(seconds) {
  clearInterval(timerId);
  let left = Math.max(0, seconds);
  const draw = () => {
    const m = String(Math.floor(left / 60)).padStart(2, "0");
    const s = String(left % 60).padStart(2, "0");
    $("#timer").textContent = `${m}:${s}`;
    if (left <= 0) {
      clearInterval(timerId);
      $("#timer").textContent = "انتهت";
    }
    left--;
  };
  draw();
  timerId = setInterval(draw, 1000);
}

analyze.addEventListener("click", analyzeChart);

newBtn.addEventListener("click", () => {
  clearInterval(timerId);
  resetImage();
  $("#assetText").textContent = "بانتظار صورة الشارت";
  $("#verdictBox").className = "verdict wait";
  $("#verdictIcon").textContent = "···";
  $("#directionText").textContent = "WAIT";
  $("#confidenceText").textContent = "ارفع أو الصق صورة للحصول على تحليل";
  $("#timer").textContent = "00:00";
  $("#reasons").innerHTML = "<li>ستظهر الأسباب الفنية هنا بعد التحليل.</li>";
  $("#indicators").innerHTML = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});
