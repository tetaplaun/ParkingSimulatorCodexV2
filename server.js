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
      maxEpisodes: clampInt(
        payload.config?.maxEpisodes ?? payload.config?.episodes,
        24,
        10000,
        clampInt(payload.config?.generations, 1, 1000, 25) * clampInt(payload.config?.population, 8, 64, 24)
      ),
      population: clampInt(payload.config?.population, 8, 64, 24),
      maxSteps: clampInt(payload.config?.maxSteps, 220, 1200, 620),
      matchTargetHeading: payload.config?.matchTargetHeading !== false
    }
  };
  scene.config.generations = Math.ceil(scene.config.maxEpisodes / scene.config.population);

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
  const routePlan = buildRouteCandidates(scene);
  const routeCandidates = routePlan.candidates;
  const total = scene.config.maxEpisodes;
  const totalGenerations = Math.ceil(total / scene.config.population);
  let episode = 0;
  let best = null;
  const expertResult = routeCandidates.length ? makeExpertResult(scene, routeCandidates) : null;

  if (!routeCandidates.length) {
    send({
      type: "blocked",
      message: routePlan.reason || "Target pose is blocked. Move or rotate the target, or clear space on one side of it.",
      rejected: routePlan.rejected
    });
    return;
  }

  const distributions = new Map(routeCandidates.map((candidate) => [
    candidate.mode,
    {
      mean: PARAMS.map((p) => p.seed),
      std: PARAMS.map((p) => (p.max - p.min) * 0.28)
    }
  ]));

  send({
    type: "start",
    total,
    route: routeCandidates[0]?.points || [],
    routeCandidates: routeCandidates.map((candidate) => ({
      mode: candidate.mode,
      points: candidate.points,
      feasible: candidate.feasible
    })),
    rejectedRoutes: routePlan.rejected,
    lidarAngles: makeLidarAngles(scene.car).map((a) => round(a, 4)),
    config: scene.config
  });

  if (expertResult) {
    best = {
      vector: PARAMS.map((param) => param.seed),
      result: expertResult,
      generation: 0,
      episode: 0
    };
    send({
      type: "episode",
      generation: 0,
      episode: 0,
      total,
      reward: round(expertResult.reward, 2),
      reached: expertResult.reached,
      collided: expertResult.collided,
      progress: 0,
      path: compressPath(expertResult.path),
      bestReward: round(expertResult.reward, 2),
      bestPath: compressPath(expertResult.path),
      route: expertResult.route,
      parkingMode: expertResult.parkingMode,
      lidar: expertResult.lidarSnapshot,
      metrics: {
        distance: round(expertResult.finalDistance, 1),
        clearance: round(expertResult.minClearance, 1),
        steps: expertResult.steps
      }
    });
  }

  for (let generation = 1; episode < total; generation += 1) {
    const evaluated = [];
    const currentPopulation = Math.min(scene.config.population, total - episode);

    for (let i = 0; i < currentPopulation; i += 1) {
      const routeCandidate = routeCandidates[episode % routeCandidates.length];
      const distribution = distributions.get(routeCandidate.mode);
      const vector = sampleVector(distribution.mean, distribution.std, rng);
      const genes = vectorToGenes(vector);
      const result = simulate(scene, routeCandidate, genes, rng, scene.config.maxSteps);
      episode += 1;
      evaluated.push({ routeMode: routeCandidate.mode, vector, result });

      let improvedBest = false;
      if (!best || result.score > best.result.score) {
        best = { vector, result, generation, episode };
        improvedBest = true;
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
        bestPath: improvedBest ? compressPath(best.result.path) : undefined,
        route: improvedBest ? best.result.route : undefined,
        parkingMode: result.parkingMode,
        lidar: result.lidarSnapshot,
        metrics: {
          distance: round(result.finalDistance, 1),
          clearance: round(result.minClearance, 1),
          steps: result.steps
        }
      });

      await yieldToEventLoop();
    }

    for (const candidate of routeCandidates) {
      const modeEvaluations = evaluated
        .filter((entry) => entry.routeMode === candidate.mode)
        .sort((a, b) => b.result.score - a.result.score);
      if (!modeEvaluations.length) {
        continue;
      }
      const distribution = distributions.get(candidate.mode);
      const eliteCount = Math.max(1, Math.ceil(modeEvaluations.length * 0.25));
      const elites = modeEvaluations.slice(0, eliteCount);
      const next = updateDistribution(distribution.mean, distribution.std, elites.map((entry) => entry.vector));
      distribution.mean = next.mean;
      distribution.std = next.std;
    }

    const bestDistribution = best ? distributions.get(best.result.parkingMode) : distributions.get(routeCandidates[0].mode);

    send({
      type: "generation",
      generation,
      totalGenerations,
      bestReward: round(best.result.reward, 2),
      bestDistance: round(best.result.finalDistance, 1),
      reached: best.result.reached,
      parkingMode: best.result.parkingMode,
      mean: bestDistribution ? vectorToGenes(bestDistribution.mean) : {}
    });
  }

  send({
    type: "done",
    bestReward: round(best.result.reward, 2),
    bestPath: compressPath(best.result.path),
    route: best.result.route,
    parkingMode: best.result.parkingMode,
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

function simulate(scene, routeCandidate, genes, rng, maxSteps) {
  const car = scene.car;
  const matchHeading = scene.config.matchTargetHeading;
  const route = Array.isArray(routeCandidate) ? routeCandidate : routeCandidate?.points || [];
  const parkingMode = Array.isArray(routeCandidate) ? "forward" : routeCandidate?.mode || "forward";
  let state = { ...scene.start, v: 0, delta: 0 };
  let waypointIndex = 0;
  let reward = 0;
  let collided = false;
  let reached = false;
  let minClearance = car.lidarRange;
  let closestDistance = distance(state, scene.target);
  const path = [{ x: state.x, y: state.y, theta: state.theta, delta: state.delta, v: state.v }];
  let lidarSnapshot = null;
  let reverseCommitted = false;
  const baseRoute = route.length
    ? route
    : matchHeading
      ? [
          pointFromState(scene.start),
          targetApproachPoint(scene, parkingMode, "near"),
          pointFromState(scene.target)
        ]
      : [pointFromState(scene.start), pointFromState(scene.target)];
  const shiftedRoute = offsetRoute(baseRoute, genes.sideOffset);
  const waypoints = matchHeading ? enforceTerminalWaypoints(shiftedRoute, scene, parkingMode) : shiftedRoute;
  const routeLength = estimateRouteLength(waypoints);

  for (let step = 0; step < maxSteps; step += 1) {
    const terminalStart = parkingMode === "reverse" ? waypoints.length - 4 : Infinity;
    const terminalRadii = parkingMode === "reverse"
      ? new Map([
          [waypoints.length - 4, 30],
          [waypoints.length - 3, 12]
        ])
      : null;
    waypointIndex = advanceWaypoint(state, waypoints, waypointIndex, genes.waypointRadius, terminalStart, 12, terminalRadii);
    const distanceToTargetNow = distance(state, scene.target);
    const terminalLeg = parkingMode === "reverse"
      ? waypointIndex >= waypoints.length - 4 || distanceToTargetNow < 190
      : waypointIndex >= waypoints.length - 2;
    const terminalLookahead = terminalLeg ? Math.min(genes.lookahead, 28) : genes.lookahead;
    let waypoint = chooseLookahead(state, waypoints, waypointIndex, terminalLookahead);
    const reverseSetupLeg = parkingMode === "reverse" && (
      waypointIndex === waypoints.length - 4 || waypointIndex === waypoints.length - 3
    );
    if (reverseSetupLeg) {
      waypoint = waypoints[waypointIndex] ?? waypoint;
    }
    if (parkingMode === "reverse" && terminalLeg && !reverseCommitted && readyForReverse(scene, state)) {
      reverseCommitted = true;
    }
    const reverseLeg = parkingMode === "reverse" && reverseCommitted;
    if (reverseLeg) {
      waypoint = pointFromState(scene.target);
    }
    const lidar = getLidar(scene, state);
    const minLidar = Math.min(...lidar.distances);
    minClearance = Math.min(minClearance, minLidar);
    lidarSnapshot = lidar;

    const action = policyAction(scene, state, waypoint, lidar, genes, rng, parkingMode, terminalLeg, reverseLeg);
    const previousState = state;
    state = stepCar(scene, state, action);

    const targetDistance = distance(state, scene.target);
    const targetHeading = Math.abs(normalizeAngle(scene.target.theta - state.theta));
    const targetProximity = clamp(1 - targetDistance / 120, 0, 1);
    const progressGain = closestDistance - targetDistance;
    closestDistance = Math.min(closestDistance, targetDistance);

    reward += progressGain * 16;
    reward -= targetDistance * 0.035;
    if (matchHeading) {
      reward -= targetHeading * targetProximity * 4.5;
    }
    reward -= Math.abs(state.delta) * 0.55;
    reward -= Math.abs(state.delta - previousState.delta) * 1.25;
    reward -= Math.abs(action.throttle) * 0.08;
    reward -= Math.max(0, 58 - minLidar) * 0.32;
    if (matchHeading) {
      reward -= Math.max(0, Math.abs(state.v) - 10) * targetProximity * 0.12;
    }
    reward -= Math.abs(state.v) > 8 ? 0.04 : 0.12;
    reward -= distanceToPolyline(state, waypoints) * 0.025;

    if (step % 3 === 0) {
      path.push({ x: state.x, y: state.y, theta: state.theta, delta: state.delta, v: state.v });
    }

    collided = state.collision || isCollision(scene, state);
    if (collided) {
      reward -= 12000 + (maxSteps - step) * 8;
      break;
    }

    const insideTarget = matchHeading
      ? targetDistance < 18 && targetHeading < 0.2 && Math.abs(state.v) < 20
      : targetDistance < 24;
    if (insideTarget) {
      reached = true;
      reward += matchHeading
        ? 4600 + (maxSteps - step) * 5 + (0.2 - targetHeading) * 4200 - Math.abs(state.v) * 9
        : 3600 + (maxSteps - step) * 5 - Math.abs(state.v) * 7;
      break;
    }
  }

  const finalDistance = distance(state, scene.target);
  const finalHeading = Math.abs(normalizeAngle(scene.target.theta - state.theta));
  const finalProximity = clamp(1 - finalDistance / 140, 0, 1);
  const finalAlignment = clamp(1 - finalHeading / Math.PI, 0, 1);
  reward -= finalDistance * 2.7;
  reward -= matchHeading ? finalHeading * (90 + finalProximity * 520) : finalHeading * 20;
  reward -= pathLength(path) * 0.015;
  reward += Math.max(0, routeLength - finalDistance) * 0.18;
  if (!collided) {
    reward += 1800;
  }
  if (matchHeading) {
    reward += finalProximity * finalAlignment * 1200;
  }

  if (!collided && !reached && finalDistance < 44 && (!matchHeading || finalHeading < 0.35)) {
    reward += 640;
  } else if (matchHeading && !collided && !reached && finalDistance < 44) {
    reward -= 900 * clamp(finalHeading / Math.PI, 0, 1);
  }

  const score = scoreResult({
    reward,
    reached,
    collided,
    finalDistance,
    finalHeading,
    minClearance,
    path
  }, matchHeading);

  path.push({ x: state.x, y: state.y, theta: state.theta, delta: state.delta, v: state.v });

  return {
    score,
    reward,
    reached,
    collided,
    path,
    route,
    parkingMode,
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

function scoreResult(result, matchHeading) {
  const alignmentPenalty = matchHeading ? result.finalHeading * 62000 : 0;
  const reachBonus = result.reached ? 1_000_000 : 0;
  const safetyBonus = result.collided ? -320_000 : 260_000;
  const clearanceBonus = clamp(result.minClearance, 0, 80) * 180;
  const distancePenalty = result.finalDistance * (matchHeading ? 2400 : 1600);
  const pathPenalty = pathLength(result.path) * 1.1;
  return reachBonus + safetyBonus + clearanceBonus - distancePenalty - alignmentPenalty - pathPenalty + result.reward * 0.02;
}

function makeExpertResult(scene, routeCandidates = []) {
  const mustUseReverse = scene.config.matchTargetHeading &&
    routeCandidates.some((candidate) => candidate.mode === "reverse") &&
    !routeCandidates.some((candidate) => candidate.mode === "forward");
  const plan = hybridAStar(scene, { mustUseReverse });
  if (!plan) {
    return null;
  }

  let minClearance = scene.car.lidarRange;
  let lidarSnapshot = null;
  let collided = false;
  for (const state of plan.path) {
    const lidar = getLidar(scene, state);
    lidarSnapshot = lidar;
    minClearance = Math.min(minClearance, Math.min(...lidar.distances));
    if (isCollision(scene, state)) {
      collided = true;
      break;
    }
  }

  const final = plan.path[plan.path.length - 1] ?? scene.start;
  const finalDistance = distance(final, scene.target);
  const finalHeading = Math.abs(normalizeAngle(scene.target.theta - final.theta));
  const reached = !collided && (
    scene.config.matchTargetHeading
      ? finalDistance < 18 && finalHeading < 0.2
      : finalDistance < 24
  );
  const reward = reached ? 85000 : 42000 - finalDistance * 220 - finalHeading * 8000;
  const result = {
    reward,
    reached,
    collided,
    path: plan.path,
    route: plan.path.map(pointFromState),
    parkingMode: plan.usedReverse ? "reverse" : "forward",
    finalDistance,
    minClearance,
    steps: plan.path.length,
    lidarSnapshot: lidarSnapshot
      ? {
          origin: { x: round(lidarSnapshot.origin.x, 1), y: round(lidarSnapshot.origin.y, 1) },
          angles: lidarSnapshot.angles.map((a) => round(a, 4)),
          distances: lidarSnapshot.distances.map((d) => round(d, 1)),
          range: scene.car.lidarRange
        }
      : null
  };
  result.score = scoreResult({
    reward: result.reward,
    reached: result.reached,
    collided: result.collided,
    finalDistance: result.finalDistance,
    finalHeading,
    minClearance: result.minClearance,
    path: result.path
  }, scene.config.matchTargetHeading);
  return result;
}

function hybridAStar(scene, options = {}) {
  const mustUseReverse = options.mustUseReverse === true;
  const car = scene.car;
  const resolution = 16;
  const thetaBins = 48;
  const primitiveDistance = 22;
  const primitiveStep = 4.4;
  const maxExpansions = 24000;
  const steerSet = [-car.maxSteer, -car.maxSteer * 0.55, 0, car.maxSteer * 0.55, car.maxSteer];
  const directionSet = scene.config.matchTargetHeading ? [1, -1] : [1];
  const start = {
    x: scene.start.x,
    y: scene.start.y,
    theta: scene.start.theta,
    v: 0,
    delta: 0
  };
  const root = {
    state: start,
    g: 0,
    f: hybridHeuristic(scene, start),
    parent: null,
    samples: [],
    direction: 0,
    steer: 0,
    usedReverse: false
  };
  const heap = [root];
  const bestCost = new Map([[hybridKey(start, resolution, thetaBins), 0]]);
  let bestNode = root;

  for (let expansions = 0; heap.length && expansions < maxExpansions; expansions += 1) {
    const node = heapPop(heap);
    if (!node) {
      break;
    }

    if ((!mustUseReverse || node.usedReverse) && hybridGoalReached(scene, node.state)) {
      return reconstructHybridPath(node, node.usedReverse);
    }

    const terminal = terminalConnection(scene, node.state);
    const terminalUsesReverse = terminal?.some((sample) => sample.v < 0) ?? false;
    if (terminal && (!mustUseReverse || node.usedReverse || terminalUsesReverse)) {
      return reconstructHybridPath({
        state: terminal[terminal.length - 1],
        parent: node,
        samples: terminal,
        usedReverse: node.usedReverse || terminalUsesReverse
      }, node.usedReverse || terminalUsesReverse);
    }

    if (hybridHeuristic(scene, node.state) < hybridHeuristic(scene, bestNode.state)) {
      bestNode = node;
    }

    for (const direction of directionSet) {
      for (const steer of steerSet) {
        const primitive = propagatePrimitive(scene, node.state, direction, steer, primitiveDistance, primitiveStep);
        if (!primitive) {
          continue;
        }
        const next = primitive[primitive.length - 1];
        const key = hybridKey(next, resolution, thetaBins);
        const switchPenalty = node.direction && node.direction !== direction ? 34 : 0;
        const reversePenalty = direction < 0 ? 6 : 0;
        const steerPenalty = Math.abs(steer) * 7 + Math.abs(steer - node.steer) * 5;
        const g = node.g + primitiveDistance + switchPenalty + reversePenalty + steerPenalty;
        if (g >= (bestCost.get(key) ?? Infinity)) {
          continue;
        }
        bestCost.set(key, g);
        heapPush(heap, {
          state: next,
          g,
          f: g + hybridHeuristic(scene, next),
          parent: node,
          samples: primitive,
          direction,
          steer,
          usedReverse: node.usedReverse || direction < 0
        });
      }
    }
  }

  return (!mustUseReverse || bestNode.usedReverse) && hybridGoalReached(scene, bestNode.state)
    ? reconstructHybridPath(bestNode, bestNode.usedReverse)
    : null;
}

function hybridHeuristic(scene, state) {
  const d = distance(state, scene.target);
  const heading = scene.config.matchTargetHeading
    ? Math.abs(normalizeAngle(scene.target.theta - state.theta))
    : 0;
  return d * 1.35 + heading * 52;
}

function hybridGoalReached(scene, state) {
  const d = distance(state, scene.target);
  if (!scene.config.matchTargetHeading) {
    return d < 24;
  }
  const heading = Math.abs(normalizeAngle(scene.target.theta - state.theta));
  return d < 18 && heading < 0.2;
}

function terminalConnection(scene, state) {
  if (!scene.config.matchTargetHeading) {
    return null;
  }
  const frame = targetFrame(scene, state);
  const heading = Math.abs(normalizeAngle(scene.target.theta - state.theta));
  if (heading > 0.26 || Math.abs(frame.lateral) > 12 || Math.abs(frame.forward) > 190) {
    return null;
  }
  const direction = frame.forward > 0 ? -1 : 1;
  return propagateToTarget(scene, state, direction);
}

function propagateToTarget(scene, state, direction) {
  const samples = [];
  let current = { ...state, delta: 0, v: direction * 18 };
  const total = distance(current, scene.target);
  const steps = Math.max(1, Math.ceil(total / 4));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    current = {
      x: state.x + (scene.target.x - state.x) * t,
      y: state.y + (scene.target.y - state.y) * t,
      theta: blendAngle(state.theta, scene.target.theta, t),
      delta: 0,
      v: direction * 18
    };
    if (isCollision(scene, current)) {
      return null;
    }
    samples.push(current);
  }
  samples.push({ x: scene.target.x, y: scene.target.y, theta: scene.target.theta, delta: 0, v: 0 });
  return samples;
}

function propagatePrimitive(scene, state, direction, steer, distanceToTravel, stepDistance) {
  const car = scene.car;
  const samples = [];
  const steps = Math.max(1, Math.ceil(distanceToTravel / stepDistance));
  const ds = distanceToTravel / steps;
  let x = state.x;
  let y = state.y;
  let theta = state.theta;

  for (let i = 0; i < steps; i += 1) {
    const beta = Math.atan(0.5 * Math.tan(steer));
    x += direction * ds * Math.cos(theta + beta);
    y += direction * ds * Math.sin(theta + beta);
    theta = normalizeAngle(theta + (direction * ds / car.wheelBase) * Math.cos(beta) * Math.tan(steer));
    const sample = { x, y, theta, delta: steer, v: direction * 24 };
    if (isCollision(scene, sample)) {
      return null;
    }
    samples.push(sample);
  }
  return samples;
}

function reconstructHybridPath(node, usedReverse) {
  const reversed = [];
  let current = node;
  while (current) {
    for (let i = current.samples.length - 1; i >= 0; i -= 1) {
      reversed.push(current.samples[i]);
    }
    if (!current.parent) {
      reversed.push(current.state);
    }
    current = current.parent;
  }
  reversed.reverse();
  return { path: dedupePath(reversed), usedReverse };
}

function dedupePath(path) {
  const result = [];
  for (const point of path) {
    const previous = result[result.length - 1];
    if (
      !previous ||
      distance(previous, point) > 0.5 ||
      Math.abs(normalizeAngle((previous.theta ?? 0) - (point.theta ?? 0))) > 0.01 ||
      Math.abs((previous.v ?? 0) - (point.v ?? 0)) > 0.5
    ) {
      result.push(point);
    }
  }
  return result;
}

function hybridKey(state, resolution, thetaBins) {
  const theta = normalizeAngle(state.theta);
  const thetaIndex = clampInt(Math.floor(((theta + Math.PI) / (Math.PI * 2)) * thetaBins), 0, thetaBins - 1, 0);
  return `${Math.round(state.x / resolution)},${Math.round(state.y / resolution)},${thetaIndex}`;
}

function heapPush(heap, node) {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].f <= node.f) {
      break;
    }
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = node;
}

function heapPop(heap) {
  if (!heap.length) {
    return null;
  }
  const top = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= heap.length) {
        break;
      }
      const child = right < heap.length && heap[right].f < heap[left].f ? right : left;
      if (heap[child].f >= last.f) {
        break;
      }
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return top;
}

function policyAction(scene, state, waypoint, lidar, genes, rng, parkingMode = "forward", terminalLeg = false, reverseLeg = false) {
  const car = scene.car;
  let desiredAngle = Math.atan2(waypoint.y - state.y, waypoint.x - state.x);
  let angleError = normalizeAngle(desiredAngle - state.theta);
  let desiredSpeed = genes.targetSpeed;
  const targetDistance = distance(state, scene.target);
  const reverseTerminal = scene.config.matchTargetHeading && parkingMode === "reverse" && reverseLeg;

  if (reverseTerminal) {
    const frame = targetFrame(scene, state);
    const lateralCorrection = clamp(Math.atan2(frame.lateral, 82), -0.72, 0.72);
    desiredAngle = normalizeAngle(scene.target.theta + Math.PI - lateralCorrection);
    desiredSpeed = -Math.max(8, genes.reverseSpeed * clamp(targetDistance / 145, 0.2, 0.9));
    angleError = normalizeAngle(desiredAngle - normalizeAngle(state.theta + Math.PI));
  } else if (scene.config.matchTargetHeading && parkingMode === "reverse" && terminalLeg) {
    const frame = targetFrame(scene, state);
    const farFrame = targetFrame(scene, targetApproachPoint(scene, "reverse", "far"));
    const lateralCorrection = clamp(Math.atan2(frame.lateral, 94), -0.78, 0.78);
    const laneAngle = normalizeAngle(scene.target.theta - lateralCorrection);
    const setupProgress = clamp(frame.forward / Math.max(1, farFrame.forward), 0, 1);
    desiredAngle = blendAngle(desiredAngle, laneAngle, 0.82 + setupProgress * 0.16);
    desiredSpeed = Math.min(desiredSpeed, Math.max(18, genes.targetSpeed * 0.45));
    if (frame.forward > farFrame.forward - 28 && Math.abs(frame.lateral) < 26) {
      desiredSpeed = Math.min(desiredSpeed, 13);
    }
    angleError = normalizeAngle(desiredAngle - state.theta);
  } else if (scene.config.matchTargetHeading && parkingMode !== "reverse" && targetDistance < 115) {
    const blend = clamp((115 - targetDistance) / 95, 0, 1);
    desiredAngle = blendAngle(desiredAngle, scene.target.theta, blend * 0.9);
    desiredSpeed = Math.min(desiredSpeed, Math.max(10, genes.targetSpeed * clamp(targetDistance / 100, 0.2, 0.7)));
    if (Math.abs(normalizeAngle(scene.target.theta - state.theta)) > 0.28 && targetDistance < 55) {
      desiredSpeed = Math.min(desiredSpeed, 16);
    }
    angleError = normalizeAngle(desiredAngle - state.theta);
  }

  const allowAutoReverse = !(parkingMode === "reverse" && terminalLeg);
  if (allowAutoReverse && !reverseTerminal && Math.abs(angleError) > Math.PI * 0.58) {
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

  const terminalParkingLane = parkingMode === "reverse" && terminalLeg;
  const speedLimit = !terminalParkingLane && frontClearance < genes.brakeDistance && desiredSpeed > 0
    ? Math.max(12, desiredSpeed * clamp(frontClearance / genes.brakeDistance, 0.18, 1))
    : desiredSpeed;
  const targetSpeed = desiredSpeed < 0 ? desiredSpeed : speedLimit;
  let throttle = clamp((targetSpeed - state.v) / 48 + genes.throttleBias, -1, 1);
  if (terminalParkingLane) {
    if (targetSpeed > 0 && state.v < targetSpeed * 0.82) {
      throttle = Math.max(throttle, 0.28);
    } else if (targetSpeed < 0 && state.v > targetSpeed * 0.82) {
      throttle = Math.min(throttle, -0.34);
    }
  }
  if (!terminalParkingLane && frontClearance < car.length * 0.55 && state.v > 0) {
    throttle = -1;
  }
  const avoidScale = terminalParkingLane ? 0.2 : 1;
  const rawSteer = angleError * genes.steerGain + avoid * genes.avoidGain * avoidScale + genes.steerBias;
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

function targetApproachPoint(scene, mode = "forward", stage = "near") {
  const distanceBehindTarget = mode === "reverse" && stage === "far"
    ? Math.max(scene.car.length * 2.9, 156)
    : Math.max(scene.car.length * 1.45, 78);
  const margin = Math.hypot(scene.car.length, scene.car.width) * 0.52;
  const direction = mode === "reverse" ? 1 : -1;
  return {
    x: clamp(scene.target.x + Math.cos(scene.target.theta) * distanceBehindTarget * direction, margin, scene.width - margin),
    y: clamp(scene.target.y + Math.sin(scene.target.theta) * distanceBehindTarget * direction, margin, scene.height - margin)
  };
}

function targetPose(scene) {
  return {
    x: scene.target.x,
    y: scene.target.y,
    theta: scene.target.theta,
    v: 0,
    delta: 0
  };
}

function targetFrame(scene, point) {
  const dx = point.x - scene.target.x;
  const dy = point.y - scene.target.y;
  const cos = Math.cos(scene.target.theta);
  const sin = Math.sin(scene.target.theta);
  return {
    forward: dx * cos + dy * sin,
    lateral: -dx * sin + dy * cos
  };
}

function readyForReverse(scene, state) {
  const frame = targetFrame(scene, state);
  const farFrame = targetFrame(scene, targetApproachPoint(scene, "reverse", "far"));
  const headingError = Math.abs(normalizeAngle(scene.target.theta - state.theta));
  return (
    frame.forward >= farFrame.forward - 18 &&
    Math.abs(frame.lateral) <= 34 &&
    headingError <= 0.72 &&
    Math.abs(state.v) <= 24
  );
}

function approachPose(scene, mode = "forward") {
  const point = targetApproachPoint(scene, mode, mode === "reverse" ? "far" : "near");
  return {
    x: point.x,
    y: point.y,
    theta: scene.target.theta,
    v: 0,
    delta: 0
  };
}

function validateTerminalApproach(scene, mode) {
  const target = targetPose(scene);
  const approaches = mode === "reverse"
    ? [approachPose(scene, mode), { ...targetApproachPoint(scene, mode, "near"), theta: scene.target.theta, v: 0, delta: 0 }]
    : [approachPose(scene, mode)];

  if (isCollision(scene, target)) {
    return { ok: false, reason: "target pose overlaps an obstacle or boundary" };
  }
  for (const approach of approaches) {
    if (isCollision(scene, approach)) {
      return { ok: false, reason: `${mode} staging pose is blocked` };
    }
  }

  const corridor = mode === "reverse" ? [approaches[0], approaches[1], target] : [approaches[0], target];
  for (let segment = 1; segment < corridor.length; segment += 1) {
    const from = corridor[segment - 1];
    const to = corridor[segment];
    const samples = Math.max(6, Math.ceil(distance(from, to) / 8));
    for (let i = 1; i < samples; i += 1) {
      const t = i / samples;
      const pose = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        theta: scene.target.theta,
        v: 0,
        delta: 0
      };
      if (isCollision(scene, pose)) {
        return { ok: false, reason: `${mode} final corridor is blocked` };
      }
    }
  }

  return { ok: true };
}

function enforceTerminalWaypoints(route, scene, mode = "forward") {
  const farApproach = targetApproachPoint(scene, mode, "far");
  const approach = targetApproachPoint(scene, mode, "near");
  const target = pointFromState(scene.target);
  const keepDistance = mode === "reverse"
    ? Math.max(scene.car.length * 2.55, 138)
    : Math.max(scene.car.length * 1.15, 64);
  const trimmed = route.filter((point, index) => index === 0 || distance(point, target) > keepDistance);
  return mode === "reverse"
    ? [...trimmed, approach, farApproach, approach, target]
    : [...trimmed, approach, target];
}

function buildRouteCandidates(scene) {
  if (!scene.config.matchTargetHeading) {
    const direct = buildRouteForMode(scene, "direct");
    return direct.feasible
      ? { candidates: [direct], rejected: [] }
      : { candidates: [], rejected: [summarizeRejectedRoute(direct)], reason: "No collision-free route to the target position was found." };
  }

  const candidates = ["forward", "reverse"].map((mode) => buildRouteForMode(scene, mode));
  const feasible = candidates.filter((candidate) => candidate.feasible);
  const rejected = candidates
    .filter((candidate) => !candidate.feasible)
    .map(summarizeRejectedRoute);

  return {
    candidates: feasible,
    rejected,
    reason: feasible.length
      ? null
      : "Target pose is blocked for both forward-in and back-in approaches."
  };
}

function buildRouteForMode(scene, mode = "direct") {
  if (mode !== "direct") {
    const terminal = validateTerminalApproach(scene, mode);
    if (!terminal.ok) {
      return {
        mode,
        points: [],
        feasible: false,
        reason: terminal.reason
      };
    }
  } else if (isCollision(scene, targetPose(scene))) {
    return {
      mode,
      points: [],
      feasible: false,
      reason: "target position overlaps an obstacle or boundary"
    };
  }

  const cell = 22;
  const cols = Math.ceil(scene.width / cell);
  const rows = Math.ceil(scene.height / cell);
  const clearance = Math.hypot(scene.car.length, scene.car.width) * 0.42 + 8;
  const goalPoint = mode === "direct" ? pointFromState(scene.target) : targetApproachPoint(scene, mode, "near");
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
  const goal = cellOf(goalPoint, cell, cols, rows);
  const target = cellOf(scene.target, cell, cols, rows);
  clearAround(blocked, start.col, start.row, 1);
  clearAround(blocked, goal.col, goal.row, 1);
  clearAround(blocked, target.col, target.row, 1);

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
      const route = simplifyRoute(unwindRoute(current, cell, scene, goalPoint), scene);
      return {
        mode,
        feasible: true,
        points: mode === "direct" ? route : enforceTerminalWaypoints(route, scene, mode)
      };
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

  return {
    mode,
    points: [],
    feasible: false,
    reason: mode === "direct"
      ? "no collision-free route to target"
      : `no collision-free route to ${mode} staging pose`
  };
}

function summarizeRejectedRoute(candidate) {
  return {
    mode: candidate.mode,
    reason: candidate.reason || "blocked"
  };
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

function unwindRoute(node, cell, scene, destination = scene.target) {
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
  route[route.length - 1] = pointFromState(destination);
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

function advanceWaypoint(state, waypoints, index, radius, terminalStart = Infinity, terminalRadius = radius, terminalRadii = null) {
  let next = index;
  while (next < waypoints.length - 2) {
    const activeRadius = terminalRadii?.get(next) ?? (next >= terminalStart ? terminalRadius : radius);
    if (distance(state, waypoints[next]) >= activeRadius) {
      break;
    }
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

function blendAngle(from, to, amount) {
  return normalizeAngle(from + normalizeAngle(to - from) * clamp(amount, 0, 1));
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
