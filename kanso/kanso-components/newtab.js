/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const form = document.getElementById("search");
const query = document.getElementById("query");

if (/^ru(?:-|$)/i.test(navigator.language)) {
  document.documentElement.lang = "ru";
  document.title = "Новая вкладка";
  document.getElementById("label").textContent = "Поиск в интернете";
  query.placeholder = "Поиск в интернете…";
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const value = query.value.trim();
  if (value) {
    dispatchEvent(new CustomEvent("ContentSearchClient", {
      detail: {
        type: "Search",
        data: {
          engineName: null,
          searchString: value,
          healthReportKey: "newtab",
          searchPurpose: "newtab",
          originalEvent: {},
        },
      },
    }));
  }
});

const canvas = document.getElementById("waves");
const context = canvas.getContext("2d");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const forcedColors = matchMedia("(forced-colors: active)");
const pixelSize = 3;

let frame = 0;
let lastDraw = -Infinity;
let colors = [];

function pixelPattern(line, column) {
  const seed = Math.imul(column + 1, 0x9e3779b1) ^ Math.imul(line + 1, 0x85ebca77);
  return Math.imul(seed ^ (seed >>> 16), 0xc2b2ae35) >>> 0;
}

function draw(time) {
  const seconds = time / 1000;
  const { width, height } = canvas;
  const lines = Math.min(23, Math.max(2, Math.floor(height / 2.8)));
  context.clearRect(0, 0, width, height);
  for (let line = 0; line < lines; line++) {
    const depth = line / (lines - 1);
    const baseline = height * (0.12 + 0.82 * depth ** 1.12);
    const amplitude = Math.min(5.5, height * 0.09) * (0.4 + 0.6 * depth);
    const phase = seconds * 0.32 - depth * 2.4;
    context.globalAlpha = 0.16 + 0.34 * depth;
    let previousColor = -1;
    for (let column = 0; column < width; column++) {
      const pattern = pixelPattern(line, column);
      if (pattern % 7 < 3) {
        continue;
      }
      const x = column / width * Math.PI * 2;
      const crest = Math.round(baseline + amplitude * (
        Math.sin(x * 1.42 + phase) + 0.38 * Math.sin(x * 2.65 - phase * 0.72)
      ));
      let color = (pattern >>> 8) % colors.length;
      if (color === previousColor) {
        color = (color + 1) % colors.length;
      }
      context.fillStyle = colors[color];
      context.fillRect(column, crest, 1, 1);
      previousColor = color;
    }
  }
  context.globalAlpha = 1;
}

function animate(time) {
  if (reduceMotion.matches) {
    draw(0);
    return;
  }
  if (time - lastDraw >= 45) {
    draw(time);
    lastDraw = time;
  }
  frame = requestAnimationFrame(animate);
}

function refreshWaves() {
  cancelAnimationFrame(frame);
  if (document.hidden || forcedColors.matches || !canvas.clientWidth) {
    return;
  }
  const width = Math.ceil(canvas.clientWidth / pixelSize);
  const height = Math.ceil(canvas.clientHeight / pixelSize);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const style = getComputedStyle(canvas);
  const wallpaper = style.getPropertyValue("--kanso-wallpaper-colors").trim().split(/\s+/).filter(Boolean);
  const foreground = getComputedStyle(document.documentElement).color;
  const tones = wallpaper.length ? wallpaper : [style.color];
  colors = Array.from({ length: 6 }, (_, index) => {
    const tone = tones[index % tones.length];
    const weight = 84 - 7 * index;
    return `color-mix(in srgb, ${tone} ${weight}%, ${foreground})`;
  });
  draw(reduceMotion.matches ? 0 : performance.now());
  if (!reduceMotion.matches) {
    frame = requestAnimationFrame(animate);
  }
}

if (context) {
  new ResizeObserver(refreshWaves).observe(canvas);
  new MutationObserver(refreshWaves).observe(document.documentElement, {
    attributeFilter: ["style", "omarchy"],
  });
  document.addEventListener("visibilitychange", refreshWaves);
  reduceMotion.addEventListener("change", refreshWaves);
  forcedColors.addEventListener("change", refreshWaves);
  refreshWaves();
}
