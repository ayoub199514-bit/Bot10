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
  const dataUrl = await fileToDataUrl(file);
  setImage(dataUrl);
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
    setImage(data.imageDataUrl);
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
  analyze.textContent = "جاري التحليل...";
  connLabel.textContent = "يقرأ الشموع...";

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
  } catch (e) {
    alert(e.message);
    connLabel.textContent = "فشل آخر تحليل";
  } finally {
    analyze.disabled = false;
    analyze.textContent = "تحليل الشارت الآن";
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
