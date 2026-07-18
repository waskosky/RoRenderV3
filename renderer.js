"use strict";

const preview = document.querySelector("#render-preview");
const previewContext = preview.getContext("2d");
const percentageRing = document.querySelector("#datapercentage");
const percentageText = document.querySelector("#datapercentagetext");
const timerText = document.querySelector("#timer");
const serverButton = document.querySelector("#startServer");
const exportButton = document.querySelector("#exportImage");
const statusText = document.querySelector("#serverStatus");

let imageData = null;
let elapsedSeconds = 0;
let timerHandle = null;

function setProgress(progress) {
  const percentage = Math.max(0, Math.min(100, Math.round(progress * 100)));
  percentageRing.dataset.percentage = String(percentage);
  percentageText.textContent = `${percentage}%`;
}

function startTimer() {
  clearInterval(timerHandle);
  elapsedSeconds = 0;
  timerText.textContent = "00:00:00";
  timerHandle = setInterval(() => {
    elapsedSeconds += 1;
    timerText.textContent = new Date(elapsedSeconds * 1000).toISOString().slice(11, 19);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
}

function beginRender(status) {
  const { width, height } = status.imageSize;
  preview.width = width;
  preview.height = height;
  imageData = previewContext.createImageData(width, height);
  previewContext.clearRect(0, 0, width, height);
  exportButton.disabled = true;
  setProgress(0);
  startTimer();
}

function appendChunk(event) {
  if (!imageData) return;
  for (let index = 0; index < event.pixels.length; index += 1) {
    const packed = Number(event.pixels[index]) >>> 0;
    const offset = (event.offset + index) * 4;
    imageData.data[offset] = packed & 0xff;
    imageData.data[offset + 1] = (packed >>> 8) & 0xff;
    imageData.data[offset + 2] = (packed >>> 16) & 0xff;
    imageData.data[offset + 3] = (packed >>> 24) & 0xff;
  }
  const startRow = Math.floor(event.offset / imageData.width);
  const endOffset = event.offset + event.pixels.length - 1;
  const endRow = Math.floor(endOffset / imageData.width);
  if (startRow === endRow) {
    previewContext.putImageData(
      imageData,
      0,
      0,
      event.offset % imageData.width,
      startRow,
      event.pixels.length,
      1,
    );
  } else {
    previewContext.putImageData(
      imageData,
      0,
      0,
      0,
      startRow,
      imageData.width,
      endRow - startRow + 1,
    );
  }
  setProgress(event.progress);
}

window.roRender.onRenderEvent((event) => {
  if (event.type === "begin") beginRender(event.status);
  else if (event.type === "chunk") appendChunk(event);
  else if (event.type === "complete") {
    stopTimer();
    setProgress(1);
    exportButton.disabled = false;
    statusText.textContent = `Saved ${event.status.artifact.imageFileName}`;
  }
});

document.querySelector("#help").addEventListener("click", () => window.roRender.openHelp());
exportButton.addEventListener("click", () => window.roRender.exportImage());
serverButton.addEventListener("click", async () => {
  serverButton.disabled = true;
  statusText.textContent = "Starting local provider…";
  try {
    const result = await window.roRender.startServer();
    statusText.textContent = `Listening on ${result.address?.host ?? result.config.host}:${result.address?.port ?? result.config.port}`;
  } catch (error) {
    serverButton.disabled = false;
    statusText.textContent = `Could not start: ${error.message}`;
  }
});
