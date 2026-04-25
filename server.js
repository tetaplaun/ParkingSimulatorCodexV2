import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const DEFAULT_CAR = {
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
  integrationStep: 0.032,
  lidarRange: 190,
  lidarCount: 23,
  lidarFov: Math.PI * 1.35
};

const PARAMS = [
  { name: "lookahead", min: 26, max: 92, seed: 56 },
  { name: "targetSpeed", min: 24, max: 92, seed: 56 },
  { name: "reverseSpeed", min: 14, max: 54, seed: 28 },
  { name: "steerGain", min: 0.8, max: 3.8, seed: 1.8 },
  { name: "avoidGain", min: 0.0, max: 3.4, seed: 1.2 },
  { name: "brakeDistance", min: 34, max: 132, seed: 78 },
  { name: "waypointRadius", min: 16, max: 58, seed: 30 },
  { name: "smoothSteer", min: 0.0, max: 0.72, seed: 0.28 },
  { name: "sideOffset", min: -38, max: 38, seed: 0 },
  { name: "steerBias", min: -0.24, max: 0.24, seed: 0 },
  { name: "throttleBias", min: -0.32, max: 0.22, seed: 0 }
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/train") {
      await handleTraining(req, res);
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    } else {
      res.end();
    }
  }
});

listen(server, PORT);

function listen(serverInstance, port) {
  const onError = (error) => {
    if (error.code === "EADDRINUSE" && port < PORT + 20) {
      listen(serverInstance, port + 1);
      return;
    }
    throw error;
  };

  serverInstance.once("error", onError);
  serverInstance.listen(port, () => {
    serverInstance.off("error", onError);
    console.log(`Parking simulator running at http://localhost:${port}`);
  });
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = join(publicDir, safePath);

  if (!fullPath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const body = await readFile(fullPath);
    res.writeHead(200, {
      "content-type": MIME[extname(fullPath)] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleTraining(req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const scene = normalizeScene(payload);
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });

  const send = (event) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    await train(scene, send);
  } catch (error) {
    console.error(error);
    send({ type: "error", message: error.message || "Training failed" });
  } finally {
    res.end();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function normalizeScene(payload) {
  const width = clamp(Number(payload.width) || 900, 420, 1600);
  const height = clamp(Number(payload.height) || 560, 320, 1000);
  const start = payload.start || {};
  const target = payload.target || {};
  const car = normalizeCar({ ...DEFAULT_CAR, ...(payload.car || {}) });

  const scene = {
    width,
    height,
    car,
    start: {
      x: clamp(Number(start.x) || width * 0.15, 20, width - 20),
      y: clamp(Number(start.y) || height * 0.78, 20, height - 20),
      theta: normalizeAngle(Number(start.theta) || 0),
      v: 0,
      delta: 0
    },
    target: {
      x: clamp(Number(target.x) || width * 0.84, 20, width - 20),
      y: clamp(Number(target.y) || height * 0.22, 20, height - 20),
      theta: normalizeAngle(Number(target.theta) || 0)
    },
    obstacles: [],
    config: {
      generations: clampInt(payload.config?.generations, 6, 26, 13),
      population: clampInt(payload.config?.population, 8, 44, 22),
      maxSteps: clampInt(payload.config?.maxSteps, 160, 520, 340)
    }
  };

  scene.obstacles = Array.isArray(payload.obstacles)
    ? payload.obstacles
        .map((raw) => ({
          x: clamp(Number(raw.x) || 0, 0, width),
          y: clamp(Number(raw.y) || 0, 0, height),
          w: clamp(Number(raw.w) || 0, 0, width),
          h: clamp(Number(raw.h) || 0, 0, height)
        }))
        .filter((rect) => rect.w >= 8 && rect.h >= 8)
    : [];

  return scene;
}

function normalizeCar(raw) {
  const length = clamp(Number(raw.length) || DEFAULT_CAR.length, 34, 90);
  const width = clamp(Number(raw.width) || DEFAULT_CAR.width, 18, 48);
  const wheelBase = clamp(Number(raw.wheelBase) || DEFAULT_CAR.wheelBase, length * 0.52, length * 0.84);
  const maxAccel = clamp(Number(raw.maxAccel ?? raw.accel) || DEFAULT_CAR.maxAccel, 20, 160);

  return {
    length,
    width,
    wheelBase,
    maxSteer: clamp(Number(raw.maxSteer) || DEFAULT_CAR.maxSteer, 0.25, 0.72),
    maxSteerRate: clamp(Number(raw.maxSteerRate) || DEFAULT_CAR.maxSteerRate, 0.55, 4.2),
    maxSpeed: clamp(Number(raw.maxSpeed) || DEFAULT_CAR.maxSpeed, 20, 180),
    maxReverse: clamp(Number(raw.maxReverse) || DEFAULT_CAR.maxReverse, 10, 100),
    maxAccel,
    maxBrake: clamp(Number(raw.maxBrake) || DEFAULT_CAR.maxBrake, maxAccel, 220),
    rollingResistance: clamp(Number(raw.rollingResistance) || DEFAULT_CAR.rollingResistance, 0, 24),
    dragCoefficient: clamp(Number(raw.dragCoefficient) || DEFAULT_CAR.dragCoefficient, 0, 0.08),
    simulationDt: clamp(Number(raw.simulationDt) || DEFAULT_CAR.simulationDt, 0.05, 0.28),
    integrationStep: clamp(Number(raw.integrationStep) || DEFAULT_CAR.integrationStep, 0.01, 0.08),
    lidarRange: clamp(Number(raw.lidarRange) || DEFAULT_CAR.lidarRange, 80, 420),
    lidarCount: clampInt(raw.lidarCount, 5, 45, DEFAULT_CAR.lidarCount),
    lidarFov: clamp(Number(raw.lidarFov) || DEFAULT_CAR.lidarFov, Math.PI * 0.45, Math.PI * 1.9)
  };
}

async function train(scene, send) {
  const rng = mulberry32(Date.now() % 2 ** 32);
  const route = buildRoute(scene);
  const total = scene.config.generations * scene.config.population;
  let episode = 0;
  let best = null;
  let mean = PARAMS.map((p) => p.seed);
  let std = PARAMS.map((p) => (p.max - p.min) * 0.28);

  send({
    type: "start",
    total,
    route,
    lidarAngles: makeLidarAngles(scene.car).map((a) => round(a, 4)),
    config: scene.config
  });

  for (let generation = 1; generation <= scene.config.generations; generation += 1) {
    const evaluated = [];

    for (let i = 0; i < scene.config.population; i += 1) {
      const vector = sampleVector(mean, std, rng);
      const genes = vectorToGenes(vector);
      const result = simulate(scene, route, genes, rng, scene.config.maxSteps);
      episode += 1;
      evaluated.push({ vector, result });

      if (!best || result.reward > best.result.reward) {
        best = { vector, result, generation, episode };
      }

      send({
        type: "episode",
        generation,
        episode,
        total,
        reward: round(result.reward, 2),
        reached: result.reached,
        collided: result.collided,
        progress: round(episode / total, 4),
        path: compressPath(result.path),
        bestReward: round(best.result.reward, 2),
        bestPath: compressPath(best.result.path),
        lidar: result.lidarSnapshot,
        metrics: {
          distance: round(result.finalDistance, 1),
          clearance: round(result.minClearance, 1),
          steps: result.steps
        }
      });

      await yieldToEventLoop();
    }

    evaluated.sort((a, b) => b.result.reward - a.result.reward);
    const eliteCount = Math.max(3, Math.ceil(evaluated.length * 0.25));
    const elites = evaluated.slice(0, eliteCount);
    const next = updateDistribution(mean, std, elites.map((e) => e.vector));
    mean = next.mean;
    std = next.std;

    send({
      type: "generation",
      generation,
      totalGenerations: scene.config.generations,
      bestReward: round(best.result.reward, 2),
      bestDistance: round(best.result.finalDistance, 1),
      reached: best.result.reached,
      mean: vectorToGenes(mean)
    });
  }

  send({
    type: "done",
    bestReward: round(best.result.reward, 2),
    bestPath: compressPath(best.result.path),
    reached: best.result.reached,
    collided: best.result.collided,
    distance: round(best.result.finalDistance, 1),
    genes: vectorToGenes(best.vector)
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sampleVector(mean, std, rng) {
  return PARAMS.map((param, index) => {
    const value = mean[index] + gaussian(rng) * std[index];
    return clamp(value, param.min, param.max);
  });
}

function vectorToGenes(vector) {
  return PARAMS.reduce((acc, param, index) => {
    acc[param.name] = round(vector[index], 4);
    return acc;
  }, {});
}

function updateDistribution(mean, std, eliteVectors) {
  const nextMean = [];
  const nextStd = [];
  for (let dim = 0; dim < PARAMS.length; dim += 1) {
    const values = eliteVectors.map((v) => v[dim]);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
    const param = PARAMS[dim];
    const minStd = (param.max - param.min) * 0.035;
    nextMean.push(clamp(mean[dim] * 0.42 + avg * 0.58, param.min, param.max));
    nextStd.push(Math.max(minStd, std[dim] * 0.35 + Math.sqrt(variance) * 0.65));
  }
  return { mean: nextMean, std: nextStd };
}

function simulate(scene, route, genes, rng, maxSteps) {
  const car = scene.car;
  let state = { ...scene.start, v: 0, delta: 0 };
  let waypointIndex = 0;
  let reward = 0;
  let collided = false;
  let reached = false;
  let minClearance = car.lidarRange;
  let closestDistance = distance(state, scene.target);
  const path = [{ x: state.x, y: state.y, theta: state.theta, delta: state.delta, v: state.v }];
  let lidarSnapshot = null;
  const waypoints = offsetRoute(route.length ? route : [scene.start, scene.target], genes.sideOffset);
  const routeLength = estimateRouteLength(waypoints);

  for (let step = 0; step < maxSteps; step += 1) {
    waypointIndex = advanceWaypoint(state, waypoints, waypointIndex, genes.waypointRadius);
    const waypoint = chooseLookahead(state, waypoints, waypointIndex, genes.lookahead);
    const lidar = getLidar(scene, state);
    const minLidar = Math.min(...lidar.distances);
    minClearance = Math.min(minClearance, minLidar);
    lidarSnapshot = lidar;

    const action = policyAction(scene, state, waypoint, lidar, genes, rng);
    const previousState = state;
    state = stepCar(scene, state, action);

    const targetDistance = distance(state, scene.target);
    const targetHeading = Math.abs(normalizeAngle(scene.target.theta - state.theta));
    const progressGain = closestDistance - targetDistance;
    closestDistance = Math.min(closestDistance, targetDistance);

    reward += progressGain * 16;
    reward -= targetDistance * 0.035;
    reward -= Math.abs(state.delta) * 0.55;
    reward -= Math.abs(state.delta - previousState.delta) * 1.25;
    reward -= Math.abs(action.throttle) * 0.08;
    reward -= Math.max(0, 58 - minLidar) * 0.32;
    reward -= Math.abs(state.v) > 8 ? 0.04 : 0.12;
    reward -= distanceToPolyline(state, waypoints) * 0.025;

    if (step % 3 === 0) {
      path.push({ x: state.x, y: state.y, theta: state.theta, delta: state.delta, v: state.v });
    }

    collided = state.collision || isCollision(scene, state);
    if (collided) {
      reward -= 2600 + (maxSteps - step) * 2;
      break;
    }

    const insideTarget = targetDistance < 24 && targetHeading < 0.78;
    if (insideTarget) {
      reached = true;
      reward += 3600 + (maxSteps - step) * 5 - Math.abs(state.v) * 8;
      break;
    }
  }

  const finalDistance = distance(state, scene.target);
  const finalHeading = Math.abs(normalizeAngle(scene.target.theta - state.theta));
  reward -= finalDistance * 2.7;
  reward -= finalHeading * 38;
  reward -= pathLength(path) * 0.015;
  reward += Math.max(0, routeLength - finalDistance) * 0.18;

  if (!collided && !reached && finalDistance < 44) {
    reward += 640;
  }

  path.push({ x: state.x, y: state.y, theta: state.theta, delta: state.delta, v: state.v });

  return {
    reward,
    reached,
    collided,
    path,
    finalDistance,
    minClearance,
    steps: path.length,
    lidarSnapshot: lidarSnapshot
      ? {
          origin: { x: round(lidarSnapshot.origin.x, 1), y: round(lidarSnapshot.origin.y, 1) },
          angles: lidarSnapshot.angles.map((a) => round(a, 4)),
          distances: lidarSnapshot.distances.map((d) => round(d, 1)),
          range: car.lidarRange
        }
      : null
  };
}

function policyAction(scene, state, waypoint, lidar, genes, rng) {
  const car = scene.car;
  const desiredAngle = Math.atan2(waypoint.y - state.y, waypoint.x - state.x);
  let angleError = normalizeAngle(desiredAngle - state.theta);
  let desiredSpeed = genes.targetSpeed;

  if (Math.abs(angleError) > Math.PI * 0.58) {
    desiredSpeed = -genes.reverseSpeed;
    angleError = normalizeAngle(desiredAngle - normalizeAngle(state.theta + Math.PI));
  }

  let avoid = 0;
  let frontClearance = car.lidarRange;
  for (let i = 0; i < lidar.distances.length; i += 1) {
    const relativeAngle = lidar.relativeAngles[i];
    const dist = lidar.distances[i];
    if (Math.abs(relativeAngle) < 0.42) {
      frontClearance = Math.min(frontClearance, dist);
    }
    const influence = clamp((genes.brakeDistance - dist) / genes.brakeDistance, 0, 1);
    if (influence > 0) {
      const side = relativeAngle === 0 ? (rng() > 0.5 ? 1 : -1) : Math.sign(relativeAngle);
      avoid -= side * influence ** 1.6 / (Math.abs(relativeAngle) + 0.32);
    }
  }

  const speedLimit = frontClearance < genes.brakeDistance
    ? Math.max(12, desiredSpeed * clamp(frontClearance / genes.brakeDistance, 0.18, 1))
    : desiredSpeed;
  const targetSpeed = desiredSpeed < 0 ? desiredSpeed : speedLimit;
  let throttle = clamp((targetSpeed - state.v) / 48 + genes.throttleBias, -1, 1);
  if (frontClearance < car.length * 0.55 && state.v > 0) {
    throttle = -1;
  }
  const rawSteer = angleError * genes.steerGain + avoid * genes.avoidGain + genes.steerBias;
  const smoothed = state.delta * genes.smoothSteer + rawSteer * (1 - genes.smoothSteer);

  return {
    steer: clamp(smoothed, -car.maxSteer, car.maxSteer),
    throttle
  };
}

function stepCar(scene, state, action) {
  const car = scene.car;
  const substeps = Math.max(1, Math.ceil(car.simulationDt / car.integrationStep));
  const dt = car.simulationDt / substeps;
  const halfWheelBase = car.wheelBase / 2;
  const steerTarget = clamp(action.steer, -car.maxSteer, car.maxSteer);
  let x = state.x;
  let y = state.y;
  let theta = state.theta;
  let v = state.v;
  let delta = state.delta || 0;
  let collision = false;

  for (let i = 0; i < substeps; i += 1) {
    const maxSteerChange = car.maxSteerRate * dt;
    delta += clamp(steerTarget - delta, -maxSteerChange, maxSteerChange);

    const tractionAccel = action.throttle >= 0
      ? action.throttle * car.maxAccel
      : action.throttle * car.maxBrake;
    const previousV = v;
    const drag = car.dragCoefficient * v * Math.abs(v);
    const rolling = Math.abs(v) > 0.15 ? car.rollingResistance * Math.sign(v) : 0;
    v = clamp(v + (tractionAccel - drag - rolling) * dt, -car.maxReverse, car.maxSpeed);
    if (Math.sign(previousV) !== Math.sign(v) && Math.abs(action.throttle) < 0.04) {
      v = 0;
    }

    const beta = Math.atan((halfWheelBase / car.wheelBase) * Math.tan(delta));
    x += v * Math.cos(theta + beta) * dt;
    y += v * Math.sin(theta + beta) * dt;
    theta = normalizeAngle(theta + (v / car.wheelBase) * Math.cos(beta) * Math.tan(delta) * dt);

    if (isCollision(scene, { x, y, theta, v, delta })) {
      collision = true;
    }
  }

  return { x, y, theta, v, delta, collision };
}

function buildRoute(scene) {
  const cell = 22;
  const cols = Math.ceil(scene.width / cell);
  const rows = Math.ceil(scene.height / cell);
  const clearance = Math.hypot(scene.car.length, scene.car.width) * 0.42 + 8;
  const blocked = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => {
      const x = col * cell + cell / 2;
      const y = row * cell + cell / 2;
      if (x < clearance || y < clearance || x > scene.width - clearance || y > scene.height - clearance) {
        return true;
      }
      return scene.obstacles.some((rect) => pointInInflatedRect(x, y, rect, clearance));
    })
  );

  const start = cellOf(scene.start, cell, cols, rows);
  const goal = cellOf(scene.target, cell, cols, rows);
  clearAround(blocked, start.col, start.row, 1);
  clearAround(blocked, goal.col, goal.row, 1);

  const key = (col, row) => `${col},${row}`;
  const open = [{ ...start, g: 0, f: heuristic(start, goal), parent: null }];
  const best = new Map([[key(start.col, start.row), open[0]]]);
  const closed = new Set();
  const dirs = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2]
  ];

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift();
    const currentKey = key(current.col, current.row);
    if (closed.has(currentKey)) {
      continue;
    }
    closed.add(currentKey);

    if (current.col === goal.col && current.row === goal.row) {
      return simplifyRoute(unwindRoute(current, cell, scene), scene);
    }

    for (const [dc, dr, cost] of dirs) {
      const col = current.col + dc;
      const row = current.row + dr;
      if (row < 0 || col < 0 || row >= rows || col >= cols || blocked[row][col]) {
        continue;
      }
      const nextKey = key(col, row);
      if (closed.has(nextKey)) {
        continue;
      }
      const g = current.g + cost;
      const known = best.get(nextKey);
      if (!known || g < known.g) {
        const node = { col, row, g, f: g + heuristic({ col, row }, goal), parent: current };
        best.set(nextKey, node);
        open.push(node);
      }
    }
  }

  return [pointFromState(scene.start), pointFromState(scene.target)];
}

function clearAround(blocked, col, row, radius) {
  for (let y = row - radius; y <= row + radius; y += 1) {
    for (let x = col - radius; x <= col + radius; x += 1) {
      if (blocked[y]?.[x] !== undefined) {
        blocked[y][x] = false;
      }
    }
  }
}

function cellOf(point, cell, cols, rows) {
  return {
    col: clampInt(Math.floor(point.x / cell), 0, cols - 1, 0),
    row: clampInt(Math.floor(point.y / cell), 0, rows - 1, 0)
  };
}

function unwindRoute(node, cell, scene) {
  const route = [];
  let current = node;
  while (current) {
    route.push({
      x: clamp(current.col * cell + cell / 2, 14, scene.width - 14),
      y: clamp(current.row * cell + cell / 2, 14, scene.height - 14)
    });
    current = current.parent;
  }
  route.reverse();
  route[0] = pointFromState(scene.start);
  route[route.length - 1] = pointFromState(scene.target);
  return route;
}

function simplifyRoute(route, scene) {
  if (route.length <= 2) {
    return route;
  }
  const simplified = [route[0]];
  let anchor = 0;
  while (anchor < route.length - 1) {
    let next = route.length - 1;
    while (next > anchor + 1 && !hasLineOfSight(route[anchor], route[next], scene)) {
      next -= 1;
    }
    simplified.push(route[next]);
    anchor = next;
  }
  return resampleRoute(simplified, 34);
}

function hasLineOfSight(a, b, scene) {
  const clearance = Math.hypot(scene.car.length, scene.car.width) * 0.34 + 6;
  const steps = Math.max(2, Math.ceil(distance(a, b) / 14));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (
      x < clearance ||
      y < clearance ||
      x > scene.width - clearance ||
      y > scene.height - clearance ||
      scene.obstacles.some((rect) => pointInInflatedRect(x, y, rect, clearance))
    ) {
      return false;
    }
  }
  return true;
}

function resampleRoute(route, spacing) {
  const result = [route[0]];
  for (let i = 1; i < route.length; i += 1) {
    const from = route[i - 1];
    const to = route[i];
    const segment = distance(from, to);
    const count = Math.max(1, Math.floor(segment / spacing));
    for (let j = 1; j <= count; j += 1) {
      const t = j / count;
      result.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return result;
}

function offsetRoute(route, offset) {
  if (Math.abs(offset) < 0.5 || route.length < 3) {
    return route;
  }
  return route.map((point, index) => {
    if (index === 0 || index === route.length - 1) {
      return point;
    }
    const prev = route[index - 1];
    const next = route[index + 1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: point.x + (-dy / len) * offset,
      y: point.y + (dx / len) * offset
    };
  });
}

function advanceWaypoint(state, waypoints, index, radius) {
  let next = index;
  while (next < waypoints.length - 2 && distance(state, waypoints[next]) < radius) {
    next += 1;
  }
  return next;
}

function chooseLookahead(state, waypoints, index, lookahead) {
  let chosen = waypoints[index] ?? waypoints[waypoints.length - 1];
  for (let i = index; i < waypoints.length; i += 1) {
    chosen = waypoints[i];
    if (distance(state, chosen) >= lookahead) {
      return chosen;
    }
  }
  return chosen;
}

function getLidar(scene, state) {
  const origin = {
    x: state.x + Math.cos(state.theta) * scene.car.length * 0.28,
    y: state.y + Math.sin(state.theta) * scene.car.length * 0.28
  };
  const relativeAngles = makeLidarAngles(scene.car);
  const angles = relativeAngles.map((angle) => normalizeAngle(state.theta + angle));
  const distances = angles.map((angle) => {
    const ray = { x: Math.cos(angle), y: Math.sin(angle) };
    let hit = distanceToBoundary(origin, ray, scene);
    for (const rect of scene.obstacles) {
      hit = Math.min(hit, rayRectDistance(origin, ray, rect));
    }
    return clamp(hit, 0, scene.car.lidarRange);
  });
  return { origin, relativeAngles, angles, distances };
}

function makeLidarAngles(car) {
  const count = Math.max(5, car.lidarCount | 0);
  const start = -car.lidarFov / 2;
  const step = car.lidarFov / (count - 1);
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function distanceToBoundary(origin, ray, scene) {
  let best = scene.car.lidarRange;
  if (ray.x > 0) best = Math.min(best, (scene.width - origin.x) / ray.x);
  if (ray.x < 0) best = Math.min(best, (0 - origin.x) / ray.x);
  if (ray.y > 0) best = Math.min(best, (scene.height - origin.y) / ray.y);
  if (ray.y < 0) best = Math.min(best, (0 - origin.y) / ray.y);
  return best > 0 ? best : scene.car.lidarRange;
}

function rayRectDistance(origin, ray, rect) {
  const invX = Math.abs(ray.x) < 1e-9 ? Infinity : 1 / ray.x;
  const invY = Math.abs(ray.y) < 1e-9 ? Infinity : 1 / ray.y;
  let t1 = (rect.x - origin.x) * invX;
  let t2 = (rect.x + rect.w - origin.x) * invX;
  let t3 = (rect.y - origin.y) * invY;
  let t4 = (rect.y + rect.h - origin.y) * invY;
  if (t1 > t2) [t1, t2] = [t2, t1];
  if (t3 > t4) [t3, t4] = [t4, t3];
  const tMin = Math.max(t1, t3);
  const tMax = Math.min(t2, t4);
  if (tMax < 0 || tMin > tMax) {
    return Infinity;
  }
  return tMin >= 0 ? tMin : tMax;
}

function isCollision(scene, state) {
  const corners = carCorners(scene.car, state);
  if (corners.some((p) => p.x < 0 || p.y < 0 || p.x > scene.width || p.y > scene.height)) {
    return true;
  }
  return scene.obstacles.some((rect) => polygonsIntersect(corners, rectCorners(rect)));
}

function carCorners(car, state) {
  const halfL = car.length / 2;
  const halfW = car.width / 2;
  const cos = Math.cos(state.theta);
  const sin = Math.sin(state.theta);
  return [
    rotatePoint(halfL, halfW, cos, sin, state),
    rotatePoint(halfL, -halfW, cos, sin, state),
    rotatePoint(-halfL, -halfW, cos, sin, state),
    rotatePoint(-halfL, halfW, cos, sin, state)
  ];
}

function rotatePoint(x, y, cos, sin, origin) {
  return {
    x: origin.x + x * cos - y * sin,
    y: origin.y + x * sin + y * cos
  };
}

function rectCorners(rect) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h }
  ];
}

function polygonsIntersect(a, b) {
  return !hasSeparatingAxis(a, b) && !hasSeparatingAxis(b, a);
}

function hasSeparatingAxis(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const p1 = a[i];
    const p2 = a[(i + 1) % a.length];
    const axis = { x: -(p2.y - p1.y), y: p2.x - p1.x };
    const aProjection = projectPolygon(a, axis);
    const bProjection = projectPolygon(b, axis);
    if (aProjection.max < bProjection.min || bProjection.max < aProjection.min) {
      return true;
    }
  }
  return false;
}

function projectPolygon(points, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

function pointInInflatedRect(x, y, rect, inflation) {
  return (
    x >= rect.x - inflation &&
    x <= rect.x + rect.w + inflation &&
    y >= rect.y - inflation &&
    y <= rect.y + rect.h + inflation
  );
}

function distanceToPolyline(point, route) {
  let best = Infinity;
  for (let i = 1; i < route.length; i += 1) {
    best = Math.min(best, distanceToSegment(point, route[i - 1], route[i]));
  }
  return best;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy || 1;
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function pathLength(path) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += distance(path[i - 1], path[i]);
  }
  return total;
}

function estimateRouteLength(route) {
  return pathLength(route);
}

function compressPath(path) {
  return path.map((point) => ({
    x: round(point.x, 1),
    y: round(point.y, 1),
    theta: round(point.theta ?? 0, 4),
    delta: round(point.delta ?? 0, 4),
    v: round(point.v ?? 0, 1)
  }));
}

function pointFromState(state) {
  return { x: state.x, y: state.y };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function heuristic(a, b) {
  return Math.hypot(a.col - b.col, a.row - b.row);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeAngle(angle) {
  let value = angle;
  while (value <= -Math.PI) value += Math.PI * 2;
  while (value > Math.PI) value -= Math.PI * 2;
  return value;
}

function round(value, decimals = 0) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
