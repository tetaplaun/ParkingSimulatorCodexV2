# Parking RL Simulator

A small full-stack parking simulator with a canvas frontend and a Node backend trainer.

## Run

```powershell
npm start
```

Open the URL printed by the server. It starts at `http://localhost:3000` and automatically tries the next port if that one is already in use.

## What it does

- Place a start car, draw multiple rectangular obstacles, and set a target bay.
- Click `Train` to stream backend training progress to the browser.
- The backend uses a lidar-aware Cross-Entropy Method policy search. It samples controller policies, simulates a low-speed kinematic bicycle model with wheelbase geometry, steering angle/rate limits, acceleration, braking, drag, and rolling resistance, then scores trials for target progress, clearance, collision avoidance, and final pose.
- The frontend draws trial paths, the current lidar rays, the heuristic route, and the best path found so far.
