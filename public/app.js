const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");

const elements = {
  trainButton: document.querySelector("#trainButton"),
  modeButtons: document.querySelector("#modeButtons"),
  heading: document.querySelector("#heading"),
  headingValue: document.querySelector("#headingValue"),
  matchHeading: document.querySelector("#matchHeading"),
  maxEpisodes: document.querySelector("#maxEpisodes"),
  hint: document.querySelector("#hint"),
  obstacleLabel: document.querySelector("#obstacleLabel"),
  obstacleFields: [...document.querySelectorAll("[data-obstacle-field]")],
  deleteObstacleButton: document.querySelector("#deleteObstacleButton"),
  exampleButton: document.querySelector("#exampleButton"),
  clearTrailsButton: document.querySelector("#clearTrailsButton"),
  clearObstaclesButton: document.querySelector("#clearObstaclesButton"),
  resetButton: document.querySelector("#resetButton"),
  statusText: document.querySelector("#statusText"),
  progressBar: document.querySelector("#progressBar"),
  episodeText: document.querySelector("#episodeText"),
  rewardText: document.querySelector("#rewardText"),
  distanceText: document.querySelector("#distanceText"),
  clearanceText: document.querySelector("#clearanceText")
};

const car = {
  length: 54,
  width: 30,
  wheelBase: 38,
  maxSteer: 0.58,
  maxSteerRate: 1.55,
  maxSpeed: 86,
  maxReverse: 46,
  maxAccel: 58,
  maxBrake: 92,
  rollingResistance: 4.2,
  dragCoefficient: 0.012,
  simulationDt: 0.16,
  integrationStep: 0.032
};

const targetBay = {
  length: 68,
  width: 44,
  rotateHandleDistance: 48,
  handleRadius: 8
};

const state = {
  mode: "obstacle",
  start: { x: 130, y: 430, theta: 0 },
  target: { x: 760, y: 120, theta: 0 },
  obstacles: [],
  selectedObstacleIndex: -1,
  hoverHandle: null,
  drag: null,
  route: [],
  trials: [],
  bestPath: [],
  bestReached: false,
  bestParkingMode: null,
  currentPath: [],
  lidar: null,
  training: false
};

loadExample();
bindEvents();
render();

function bindEvents() {
  elements.modeButtons.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    state.mode = button.dataset.mode;
    for (const item of elements.modeButtons.querySelectorAll("button")) {
      item.classList.toggle("active", item === button);
    }
    if (state.mode !== "obstacle") {
      clearObstacleSelection();
    }
    syncHeadingFromMode();
    updateHint();
    render();
  });

  elements.heading.addEventListener("input", () => {
    const theta = degToRad(Number(elements.heading.value));
    if (state.mode === "target") {
      state.target.theta = theta;
    } else {
      state.start.theta = theta;
    }
    updateHeadingLabel();
    render();
  });

  elements.matchHeading.addEventListener("change", () => {
    resetTrainingView();
  });

  elements.maxEpisodes.addEventListener("change", () => {
    elements.maxEpisodes.value = String(readMaxEpisodes());
    resetTrainingView();
  });

  for (const input of elements.obstacleFields) {
    input.addEventListener("input", () => {
      updateSelectedObstacleFromFields(input);
    });
  }

  elements.deleteObstacleButton.addEventListener("click", deleteSelectedObstacle);

  elements.trainButton.addEventListener("click", train);
  elements.exampleButton.addEventListener("click", () => {
    loadExample();
    resetTrainingView();
    syncObstacleEditor();
    render();
  });
  elements.clearTrailsButton.addEventListener("click", () => {
    resetTrainingView();
    render();
  });
  elements.clearObstaclesButton.addEventListener("click", () => {
    state.obstacles = [];
    state.selectedObstacleIndex = -1;
    state.hoverHandle = null;
    resetTrainingView();
    syncObstacleEditor();
    render();
  });
  elements.resetButton.addEventListener("click", () => {
    state.start = { x: 130, y: 430, theta: 0 };
    state.target = { x: 760, y: 120, theta: 0 };
    state.obstacles = [];
    state.selectedObstacleIndex = -1;
    state.hoverHandle = null;
    resetTrainingView();
    syncHeadingFromMode();
    syncObstacleEditor();
    render();
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", render);

  syncHeadingFromMode();
  syncObstacleEditor();
  updateHint();
}

function onPointerDown(event) {
  if (state.training) return;
  const point = getCanvasPoint(event);
  if (state.mode === "car") {
    clearObstacleSelection();
    state.start.x = point.x;
    state.start.y = point.y;
    state.start.theta = degToRad(Number(elements.heading.value));
    resetTrainingView();
    render();
    return;
  }
  if (state.mode === "target") {
    clearObstacleSelection();
    const hit = hitTestTarget(point);
    if (hit === "rotate") {
      state.drag = { type: "target-rotate", start: point, startTheta: state.target.theta };
      resetTrainingView();
      canvas.setPointerCapture(event.pointerId);
      render();
      return;
    }
    if (hit === "move") {
      state.drag = {
        type: "target-move",
        start: point,
        offset: { x: point.x - state.target.x, y: point.y - state.target.y }
      };
      resetTrainingView();
      canvas.setPointerCapture(event.pointerId);
      render();
      return;
    }
    state.target.x = clamp(point.x, targetBay.length / 2, canvas.width - targetBay.length / 2);
    state.target.y = clamp(point.y, targetBay.width / 2, canvas.height - targetBay.width / 2);
    state.target.theta = degToRad(Number(elements.heading.value));
    resetTrainingView();
    render();
    return;
  }
  if (state.mode === "erase") {
    const index = findObstacleAt(point);
    if (index >= 0) {
      state.obstacles.splice(index, 1);
      if (state.selectedObstacleIndex === index) {
        state.selectedObstacleIndex = -1;
        state.hoverHandle = null;
      } else if (state.selectedObstacleIndex > index) {
        state.selectedObstacleIndex -= 1;
      }
      resetTrainingView();
      syncObstacleEditor();
      render();
    }
    return;
  }

  const hit = hitTestObstacle(point);
  if (hit) {
    state.selectedObstacleIndex = hit.index;
    const rect = selectedObstacle();
    state.drag = {
      type: hit.handle ? "resize" : "move",
      handle: hit.handle,
      start: point,
      current: point,
      startRect: { ...rect },
      offset: { x: point.x - rect.x, y: point.y - rect.y }
    };
    resetTrainingView();
    syncObstacleEditor();
    canvas.setPointerCapture(event.pointerId);
    render();
    return;
  }

  state.selectedObstacleIndex = -1;
  state.hoverHandle = null;
  syncObstacleEditor();
  state.drag = { type: "create", start: point, current: point };
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  const point = getCanvasPoint(event);
  if (!state.drag) {
    updateCanvasCursor(point);
    return;
  }

  state.drag.current = point;
  if (state.drag.type === "move") {
    moveSelectedObstacle(point);
    syncObstacleEditor();
  } else if (state.drag.type === "resize") {
    resizeSelectedObstacle(point);
    syncObstacleEditor();
  } else if (state.drag.type === "target-move") {
    moveTarget(point);
    syncHeadingFromMode();
  } else if (state.drag.type === "target-rotate") {
    rotateTarget(point);
    syncHeadingFromMode();
  }
  render();
}

function onPointerUp(event) {
  if (!state.drag) return;
  const drag = state.drag;
  state.drag = null;
  canvas.releasePointerCapture(event.pointerId);
  canvas.style.cursor = "";
  if (drag.type === "create") {
    const rect = rectFromPoints(drag.start, drag.current);
    normalizeRect(rect);
    if (rect.w >= 10 && rect.h >= 10) {
      state.obstacles.push(rect);
      state.selectedObstacleIndex = state.obstacles.length - 1;
      syncObstacleEditor();
      resetTrainingView();
    }
  } else if (drag.type === "move" || drag.type === "resize") {
    normalizeRect(selectedObstacle());
    resetTrainingView();
  } else if (drag.type === "target-move" || drag.type === "target-rotate") {
    resetTrainingView();
  }
  render();
}

function onKeyDown(event) {
  if (state.training) return;
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedObstacleIndex >= 0) {
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return;
    event.preventDefault();
    deleteSelectedObstacle();
  }
}

function selectedObstacle() {
  return state.obstacles[state.selectedObstacleIndex] || null;
}

function clearObstacleSelection() {
  if (state.selectedObstacleIndex !== -1) {
    state.selectedObstacleIndex = -1;
    state.hoverHandle = null;
    syncObstacleEditor();
  }
}

function deleteSelectedObstacle() {
  if (state.selectedObstacleIndex < 0) return;
  state.obstacles.splice(state.selectedObstacleIndex, 1);
  state.selectedObstacleIndex = -1;
  state.hoverHandle = null;
  resetTrainingView();
  syncObstacleEditor();
  render();
}

function moveTarget(point) {
  state.target.x = clamp(
    point.x - state.drag.offset.x,
    targetBay.length / 2,
    canvas.width - targetBay.length / 2
  );
  state.target.y = clamp(
    point.y - state.drag.offset.y,
    targetBay.width / 2,
    canvas.height - targetBay.width / 2
  );
}

function rotateTarget(point) {
  state.target.theta = normalizeAngle(Math.atan2(point.y - state.target.y, point.x - state.target.x));
}

function moveSelectedObstacle(point) {
  const rect = selectedObstacle();
  if (!rect) return;
  rect.x = clamp(point.x - state.drag.offset.x, 0, canvas.width - rect.w);
  rect.y = clamp(point.y - state.drag.offset.y, 0, canvas.height - rect.h);
}

function resizeSelectedObstacle(point) {
  const rect = selectedObstacle();
  if (!rect) return;
  const minSize = 16;
  const start = state.drag.startRect;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  const dx = point.x - state.drag.start.x;
  const dy = point.y - state.drag.start.y;
  const handle = state.drag.handle || "";

  if (handle.includes("w")) {
    left = clamp(start.x + dx, 0, right - minSize);
  }
  if (handle.includes("e")) {
    right = clamp(start.x + start.w + dx, left + minSize, canvas.width);
  }
  if (handle.includes("n")) {
    top = clamp(start.y + dy, 0, bottom - minSize);
  }
  if (handle.includes("s")) {
    bottom = clamp(start.y + start.h + dy, top + minSize, canvas.height);
  }

  rect.x = left;
  rect.y = top;
  rect.w = right - left;
  rect.h = bottom - top;
}

function updateSelectedObstacleFromFields(changedInput) {
  const rect = selectedObstacle();
  if (!rect) return;

  const values = Object.fromEntries(
    elements.obstacleFields.map((input) => [input.dataset.obstacleField, Number(input.value)])
  );

  const next = {
    x: Number.isFinite(values.x) ? values.x : rect.x,
    y: Number.isFinite(values.y) ? values.y : rect.y,
    w: Number.isFinite(values.w) ? values.w : rect.w,
    h: Number.isFinite(values.h) ? values.h : rect.h
  };
  const prop = changedInput.dataset.obstacleField;
  if (prop === "w") {
    next.w = clamp(next.w, 16, canvas.width - rect.x);
  } else if (prop === "h") {
    next.h = clamp(next.h, 16, canvas.height - rect.y);
  } else if (prop === "x") {
    next.x = clamp(next.x, 0, canvas.width - rect.w);
  } else if (prop === "y") {
    next.y = clamp(next.y, 0, canvas.height - rect.h);
  }

  rect.x = next.x;
  rect.y = next.y;
  rect.w = next.w;
  rect.h = next.h;
  normalizeRect(rect);
  resetTrainingView();
  syncObstacleEditor();
  render();
}

function syncObstacleEditor() {
  const rect = selectedObstacle();
  elements.obstacleLabel.textContent = rect ? `#${state.selectedObstacleIndex + 1}` : "None";
  elements.deleteObstacleButton.disabled = !rect;
  for (const input of elements.obstacleFields) {
    input.disabled = !rect;
    const prop = input.dataset.obstacleField;
    input.value = rect ? String(Math.round(rect[prop])) : "";
  }
}

function hitTestObstacle(point) {
  const handle = hitTestSelectedHandle(point);
  if (handle) {
    return { index: state.selectedObstacleIndex, handle };
  }

  const index = findObstacleAt(point);
  if (index >= 0) {
    return { index, handle: null };
  }
  return null;
}

function hitTestSelectedHandle(point) {
  const rect = selectedObstacle();
  if (!rect) return null;
  const handles = obstacleHandles(rect);
  for (const handle of handles) {
    if (pointInRect(point, handle.rect)) {
      return handle.name;
    }
  }
  return null;
}

function findObstacleAt(point) {
  for (let index = state.obstacles.length - 1; index >= 0; index -= 1) {
    if (pointInRect(point, state.obstacles[index])) {
      return index;
    }
  }
  return -1;
}

function updateCanvasCursor(point) {
  if (state.mode === "target") {
    const hit = hitTestTarget(point);
    canvas.style.cursor = hit === "rotate" ? "grab" : hit === "move" ? "move" : "crosshair";
    return;
  }
  if (state.mode !== "obstacle") {
    canvas.style.cursor = state.mode === "erase" ? "not-allowed" : "";
    return;
  }
  const handle = hitTestSelectedHandle(point);
  if (handle) {
    state.hoverHandle = handle;
    canvas.style.cursor = handleCursor(handle);
    return;
  }
  state.hoverHandle = null;
  canvas.style.cursor = findObstacleAt(point) >= 0 ? "move" : "crosshair";
}

function handleCursor(handle) {
  const cursors = {
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize"
  };
  return cursors[handle] || "default";
}

function hitTestTarget(point) {
  const handle = targetRotateHandle();
  if (Math.hypot(point.x - handle.x, point.y - handle.y) <= targetBay.handleRadius + 5) {
    return "rotate";
  }
  return pointInRotatedTarget(point) ? "move" : null;
}

function targetRotateHandle() {
  return {
    x: state.target.x + Math.cos(state.target.theta) * targetBay.rotateHandleDistance,
    y: state.target.y + Math.sin(state.target.theta) * targetBay.rotateHandleDistance
  };
}

function pointInRotatedTarget(point) {
  const local = worldToTargetLocal(point);
  return (
    Math.abs(local.x) <= targetBay.length / 2 &&
    Math.abs(local.y) <= targetBay.width / 2
  );
}

function worldToTargetLocal(point) {
  const dx = point.x - state.target.x;
  const dy = point.y - state.target.y;
  const cos = Math.cos(-state.target.theta);
  const sin = Math.sin(-state.target.theta);
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos
  };
}

async function train() {
  if (state.training) return;
  state.training = true;
  resetTrainingView();
  setStatus("Training");
  elements.trainButton.disabled = true;
  elements.matchHeading.disabled = true;
  elements.maxEpisodes.disabled = true;

  const payload = {
    width: canvas.width,
    height: canvas.height,
    start: state.start,
    target: state.target,
    obstacles: state.obstacles,
    car,
    config: {
      maxEpisodes: readMaxEpisodes(),
      population: 24,
      maxSteps: 340,
      matchTargetHeading: elements.matchHeading.checked
    }
  };

  try {
    const response = await fetch("/api/train", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok || !response.body) {
      throw new Error(`Training request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventsSincePaint = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          const event = JSON.parse(line);
          handleTrainingEvent(event);
          eventsSincePaint += 1;
          if (event.source === "seed" || event.bestPath?.length || eventsSincePaint >= 20) {
            eventsSincePaint = 0;
            await nextPaint();
          }
        }
      }
    }

    if (buffer.trim()) {
      handleTrainingEvent(JSON.parse(buffer));
    }
  } catch (error) {
    setStatus(error.message || "Training failed");
  } finally {
    state.training = false;
    elements.trainButton.disabled = false;
    elements.matchHeading.disabled = false;
    elements.maxEpisodes.disabled = false;
    render();
  }
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function handleTrainingEvent(event) {
  if (event.type === "start") {
    state.route = event.route || [];
    elements.episodeText.textContent = `0 / ${event.total}`;
    elements.progressBar.style.width = "0%";
    setStatus("Training");
    render();
    return;
  }

  if (event.type === "episode") {
    if (event.route?.length) {
      state.route = event.route;
    }
    state.currentPath = event.path || [];
    if (event.path?.length && event.source !== "seed") {
      state.trials.push({
        path: event.path,
        reward: event.reward,
        reached: event.reached,
        collided: event.collided
      });
      if (state.trials.length > 170) {
        state.trials.shift();
      }
    }
    if (event.bestPath?.length) {
      state.bestPath = event.bestPath;
      state.bestReached = Boolean(event.bestReached ?? event.reached);
      state.bestParkingMode = event.bestParkingMode || event.parkingMode || state.bestParkingMode;
    }
    if (!state.bestReached || event.reached || event.bestPath?.length) {
      state.lidar = event.lidar;
    }
    elements.episodeText.textContent = `${event.episode} / ${event.total}`;
    elements.progressBar.style.width = `${Math.round(event.progress * 100)}%`;
    elements.rewardText.textContent = formatNumber(event.bestReward);
    const displayedMetrics = event.bestMetrics || event.metrics;
    elements.distanceText.textContent = `${formatNumber(displayedMetrics.distance)} px`;
    elements.clearanceText.textContent = `${formatNumber(displayedMetrics.clearance)} px`;
    if (event.source === "seed" && state.bestReached) {
      const mode = state.bestParkingMode === "reverse" ? "back-in" : "forward-in";
      setStatus(`Seeded solution (${mode})`);
    }
    render();
    return;
  }

  if (event.type === "generation") {
    setStatus(event.reached ? `Solved gen ${event.generation}` : `Gen ${event.generation}`);
    return;
  }

  if (event.type === "done") {
    state.bestPath = event.bestPath || state.bestPath;
    state.route = event.route || state.route;
    state.bestReached = Boolean(event.reached);
    state.bestParkingMode = event.parkingMode || state.bestParkingMode;
    elements.progressBar.style.width = "100%";
    elements.rewardText.textContent = formatNumber(event.bestReward);
    elements.distanceText.textContent = `${formatNumber(event.distance)} px`;
    const mode = event.parkingMode === "reverse" ? "back-in" : "forward-in";
    setStatus(event.reached ? `Target reached (${mode})` : `Best effort (${mode})`);
    render();
    return;
  }

  if (event.type === "blocked") {
    elements.progressBar.style.width = "0%";
    elements.episodeText.textContent = "0 / 0";
    elements.rewardText.textContent = "-";
    elements.distanceText.textContent = "-";
    elements.clearanceText.textContent = "-";
    setStatus(event.message || "Target pose blocked");
    render();
    return;
  }

  if (event.type === "error") {
    setStatus(event.message || "Training failed");
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawLot();
  drawRoute();
  drawTrials();
  drawObstacles();
  drawObstacleSelection();
  drawDragPreview();
  drawTarget();
  drawBestPath();
  drawLidar();
  drawCar(state.start, "#1976d2");
}

function drawLot() {
  ctx.save();
  ctx.fillStyle = "#e8ece7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(71, 82, 76, 0.14)";
  ctx.lineWidth = 1;
  for (let x = 30; x < canvas.width; x += 30) {
    line(x, 0, x, canvas.height);
  }
  for (let y = 30; y < canvas.height; y += 30) {
    line(0, y, canvas.width, y);
  }

  ctx.strokeStyle = "#b6c0b5";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.restore();
}

function drawObstacles() {
  ctx.save();
  for (let index = 0; index < state.obstacles.length; index += 1) {
    const rect = state.obstacles[index];
    ctx.fillStyle = "#5c625e";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = index === state.selectedObstacleIndex ? "#f5b82e" : "#303633";
    ctx.lineWidth = index === state.selectedObstacleIndex ? 3 : 2;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    for (let x = rect.x - rect.h; x < rect.x + rect.w + rect.h; x += 18) {
      ctx.beginPath();
      ctx.moveTo(x, rect.y + rect.h);
      ctx.lineTo(x + rect.h, rect.y);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawObstacleSelection() {
  const rect = selectedObstacle();
  if (!rect) return;
  ctx.save();
  ctx.strokeStyle = "#f5b82e";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8);
  ctx.setLineDash([]);

  for (const handle of obstacleHandles(rect)) {
    const active = handle.name === state.hoverHandle || state.drag?.handle === handle.name;
    ctx.fillStyle = active ? "#f5b82e" : "#ffffff";
    ctx.strokeStyle = "#7a4e00";
    ctx.lineWidth = 2;
    ctx.fillRect(handle.rect.x, handle.rect.y, handle.rect.w, handle.rect.h);
    ctx.strokeRect(handle.rect.x, handle.rect.y, handle.rect.w, handle.rect.h);
  }
  ctx.restore();
}

function drawDragPreview() {
  if (!state.drag || state.drag.type !== "create") return;
  const rect = rectFromPoints(state.drag.start, state.drag.current);
  ctx.save();
  ctx.fillStyle = "rgba(196, 79, 61, 0.24)";
  ctx.strokeStyle = "#c44f3d";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawTarget() {
  const target = state.target;
  const showHandle = state.mode === "target" || state.drag?.type?.startsWith("target-");
  ctx.save();
  ctx.translate(target.x, target.y);
  ctx.rotate(target.theta);
  if (showHandle) {
    ctx.strokeStyle = "rgba(15, 157, 88, 0.7)";
    ctx.lineWidth = 2;
    line(targetBay.length / 2, 0, targetBay.rotateHandleDistance, 0);
  }
  ctx.fillStyle = "rgba(15, 157, 88, 0.14)";
  ctx.strokeStyle = "#0f9d58";
  ctx.lineWidth = 3;
  roundRect(-targetBay.length / 2, -targetBay.width / 2, targetBay.length, targetBay.width, 4);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(15, 157, 88, 0.7)";
  ctx.lineWidth = 2;
  line(-18, -14, 18, -14);
  line(-18, 14, 18, 14);
  ctx.fillStyle = "#0f9d58";
  ctx.beginPath();
  ctx.moveTo(38, 0);
  ctx.lineTo(24, -7);
  ctx.lineTo(24, 7);
  ctx.closePath();
  ctx.fill();
  if (showHandle) {
    ctx.beginPath();
    ctx.arc(targetBay.rotateHandleDistance, 0, targetBay.handleRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0f6b41";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function drawCar(pose, color) {
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.theta);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#0e365f";
  ctx.lineWidth = 2;
  roundRect(-car.length / 2, -car.width / 2, car.length, car.width, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  roundRect(3, -car.width / 2 + 5, 17, car.width - 10, 4);
  ctx.fill();
  drawWheel(-car.wheelBase / 2, -car.width / 2 - 1, 0);
  drawWheel(-car.wheelBase / 2, car.width / 2 + 1, 0);
  drawWheel(car.wheelBase / 2, -car.width / 2 - 1, pose.delta || 0);
  drawWheel(car.wheelBase / 2, car.width / 2 + 1, pose.delta || 0);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(car.length / 2 + 8, 0);
  ctx.lineTo(car.length / 2 - 3, -6);
  ctx.lineTo(car.length / 2 - 3, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawWheel(x, y, steer) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(steer);
  ctx.fillStyle = "#0b2949";
  roundRect(-6, -2.5, 12, 5, 2);
  ctx.fill();
  ctx.restore();
}

function drawRoute() {
  if (state.route.length < 2) return;
  drawPath(state.route, {
    color: "rgba(33, 106, 76, 0.3)",
    width: 3,
    dash: [7, 7]
  });
}

function drawTrials() {
  const minReward = Math.min(...state.trials.map((trial) => trial.reward), 0);
  const maxReward = Math.max(...state.trials.map((trial) => trial.reward), 1);
  state.trials.forEach((trial, index) => {
    const age = (index + 1) / Math.max(1, state.trials.length);
    const score = (trial.reward - minReward) / Math.max(1, maxReward - minReward);
    const alpha = state.bestReached
      ? 0.018 + age * 0.035 + score * 0.035
      : 0.05 + age * 0.18 + score * 0.18;
    const color = trial.reached
      ? `rgba(15, 157, 88, ${Math.min(state.bestReached ? 0.22 : 0.66, alpha + 0.2)})`
      : trial.collided
        ? `rgba(196, 79, 61, ${alpha})`
        : `rgba(92, 111, 136, ${alpha})`;
    drawPath(trial.path, { color, width: state.bestReached ? 1 : 1.5 });
  });
}

function drawBestPath() {
  if (state.bestPath.length < 2) return;
  drawPath(state.bestPath, { color: "#f5b82e", width: 5 });
  drawPath(state.bestPath, { color: "#7a4e00", width: 1.5 });
  const last = state.bestPath[state.bestPath.length - 1];
  drawCar(last, "#f5b82e");
}

function drawLidar() {
  if (!state.lidar?.origin || !state.lidar?.angles) return;
  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0; i < state.lidar.angles.length; i += 1) {
    const angle = state.lidar.angles[i];
    const distance = state.lidar.distances[i];
    const ratio = distance / state.lidar.range;
    ctx.strokeStyle = ratio < 0.32
      ? "rgba(196, 79, 61, 0.44)"
      : "rgba(25, 118, 210, 0.18)";
    ctx.beginPath();
    ctx.moveTo(state.lidar.origin.x, state.lidar.origin.y);
    ctx.lineTo(
      state.lidar.origin.x + Math.cos(angle) * distance,
      state.lidar.origin.y + Math.sin(angle) * distance
    );
    ctx.stroke();
  }
  ctx.restore();
}

function drawPath(path, options) {
  if (!path || path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = options.color;
  ctx.lineWidth = options.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (options.dash) ctx.setLineDash(options.dash);
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i += 1) {
    ctx.lineTo(path[i].x, path[i].y);
  }
  ctx.stroke();
  ctx.restore();
}

function loadExample() {
  state.start = { x: 116, y: 444, theta: degToRad(-4) };
  state.target = { x: 778, y: 114, theta: 0 };
  state.obstacles = [
    { x: 260, y: 90, w: 74, h: 260 },
    { x: 424, y: 238, w: 236, h: 76 },
    { x: 666, y: 330, w: 72, h: 148 },
    { x: 112, y: 196, w: 92, h: 68 }
  ];
  state.selectedObstacleIndex = -1;
  state.hoverHandle = null;
  syncHeadingFromMode();
}

function resetTrainingView() {
  state.route = [];
  state.trials = [];
  state.bestPath = [];
  state.bestReached = false;
  state.bestParkingMode = null;
  state.currentPath = [];
  state.lidar = null;
  elements.progressBar.style.width = "0%";
  elements.episodeText.textContent = "0 / 0";
  elements.rewardText.textContent = "-";
  elements.distanceText.textContent = "-";
  elements.clearanceText.textContent = "-";
  setStatus("Ready");
}

function setStatus(text) {
  elements.statusText.textContent = text;
}

function readMaxEpisodes() {
  return Math.round(clamp(Number(elements.maxEpisodes.value) || 600, 50, 10000));
}

function syncHeadingFromMode() {
  const theta = state.mode === "target" ? state.target.theta : state.start.theta;
  elements.heading.value = String(Math.round(radToDeg(normalizeAngle(theta))));
  updateHeadingLabel();
}

function updateHeadingLabel() {
  elements.headingValue.textContent = `${elements.heading.value} deg`;
}

function updateHint() {
  const hints = {
    car: "Click to place the start car",
    obstacle: "Drag empty space to add; drag selected handles to resize",
    target: "Drag the target to move; drag its handle to rotate",
    erase: "Click an obstacle to remove it"
  };
  elements.hint.textContent = hints[state.mode];
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * canvas.width, 0, canvas.width),
    y: clamp(((event.clientY - rect.top) / rect.height) * canvas.height, 0, canvas.height)
  };
}

function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  };
}

function normalizeRect(rect) {
  if (!rect) return;
  rect.w = clamp(rect.w, 16, canvas.width);
  rect.h = clamp(rect.h, 16, canvas.height);
  rect.x = clamp(rect.x, 0, canvas.width - rect.w);
  rect.y = clamp(rect.y, 0, canvas.height - rect.h);
}

function obstacleHandles(rect) {
  const size = 10;
  const half = size / 2;
  const points = {
    nw: [rect.x, rect.y],
    n: [rect.x + rect.w / 2, rect.y],
    ne: [rect.x + rect.w, rect.y],
    e: [rect.x + rect.w, rect.y + rect.h / 2],
    se: [rect.x + rect.w, rect.y + rect.h],
    s: [rect.x + rect.w / 2, rect.y + rect.h],
    sw: [rect.x, rect.y + rect.h],
    w: [rect.x, rect.y + rect.h / 2]
  };
  return Object.entries(points).map(([name, [x, y]]) => ({
    name,
    rect: { x: x - half, y: y - half, w: size, h: size }
  }));
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function degToRad(degrees) {
  return (degrees * Math.PI) / 180;
}

function radToDeg(radians) {
  return (radians * 180) / Math.PI;
}

function normalizeAngle(angle) {
  let value = angle;
  while (value <= -Math.PI) value += Math.PI * 2;
  while (value > Math.PI) value -= Math.PI * 2;
  return value;
}
