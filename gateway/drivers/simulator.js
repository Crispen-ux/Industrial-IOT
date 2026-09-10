// Simulates a bag-filling scale's weight cycle: fill -> settle -> dump -> repeat.
// Every driver below calls this instead of real hardware for now. When you swap
// in a real protocol client, replace the call to `step()` with the actual
// register/tag read and feed its value into the same {weight, phase, bagCount, connected} shape.

function createSimState(target) {
  return {
    weight: 0,
    phase: "filling",
    bagCount: Math.floor(Math.random() * 40) + 10,
    connected: true,
  };
}

function step(state, target) {
  // occasional simulated dropout, so the dashboard's offline handling gets exercised
  if (Math.random() < 0.01) state.connected = !state.connected;
  if (!state.connected) return state;

  if (state.phase === "filling") {
    const increment = target * (0.08 + Math.random() * 0.06);
    state.weight = Math.min(target * 1.02, state.weight + increment);
    if (state.weight >= target * (0.985 + Math.random() * 0.02)) {
      state.phase = "settling";
    }
  } else if (state.phase === "settling") {
    state.phase = "dumping";
    state.bagCount += 1;
  } else if (state.phase === "dumping") {
    state.weight = 0;
    state.phase = "filling";
  }
  return state;
}

module.exports = { createSimState, step };
